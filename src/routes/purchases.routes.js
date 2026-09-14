import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

// ⚠ لازم تحديد المسار "/purchases" صراحةً — راجع نفس التعليق في
// sales.routes.js: بدونه، أي بوابة requirePage في أي router آخر مركّب
// على /api كانت ستُطبَّق على هذا الطلب أولًا (اكتُشفت الثغرة هنا فعليًا).
router.use("/purchases", authenticate, requirePage("purchases"), requireNotDenied("purchase"));

const PAYMENT_METHODS = ["safe_cash", "safe_network", "scrap", "office", "deferred"];
const KARATS = [24, 22, 21, 18, 14];

/**
 * POST /api/purchases — تسجيل شراء من مورد (AddPurchaseModal.jsx →
 * createLotCore في الفرونت إند).
 *
 * الوثائق الحقيقية لهذا الـendpoint مبنية بالكامل على posting_rules
 * المزروعة أصلًا من chart.js (purchase_cash, purchase_network,
 * purchase_deferred, purchase_office, purchase_scrap_pay,
 * workmanship_paid) — رجوع لهذا الملف عند أي شك في حساب.
 *
 * قرارات اتُّخذت بعد سؤال صريح ووافقتَ عليها:
 * 1. جدولا `purchases`/`lots` أُعيد تصميمهما في migration 004 (كانا
 *    هيكلين أساسيين فقط) — راجع تعليقات تلك الهجرة لتفاصيل كل عمود.
 * 2. السداد بالكسر: القطع المشتراة والكسر المدفوع مستقلان تمامًا (عيار
 *    ووزن كل منهما منفصل في الفورم بلا أي تحقق رابط بينهما في المرجع) —
 *    فيُرحَّلان كسطرين منفصلين في دفتر الوزن، لا سطر واحد مدمج.
 */
router.post("/purchases", async (req, res, next) => {
  const body = req.body || {};
  const { supplierId, paymentMethod, officeId, notes } = body;
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!supplierId) {
    return res.status(400).json({ error: "supplier_required" });
  }
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: "invalid_payment_method" });
  }
  if (!lines.length) {
    return res.status(400).json({ error: "no_lines" });
  }
  for (const l of lines) {
    if (
      !KARATS.includes(Number(l.karat)) ||
      !(Number(l.weight) > 0) ||
      !(Number(l.costPerGram) > 0) ||
      l.workmanshipTotal == null ||
      Number(l.workmanshipTotal) < 0
    ) {
      return res.status(400).json({ error: "invalid_line", line: l });
    }
  }
  if (paymentMethod === "office" && !officeId) {
    return res.status(400).json({ error: "office_required" });
  }
  let scrapKarat = null;
  let scrapWeight = 0;
  if (paymentMethod === "scrap") {
    scrapKarat = Number(body.scrapKarat);
    scrapWeight = Number(body.scrapWeight) || 0;
    if (!KARATS.includes(scrapKarat) || !(scrapWeight > 0)) {
      return res.status(400).json({ error: "scrap_payment_requires_karat_and_weight" });
    }
  }
  // آجل فقط: هل الأجور تُسدَّد نقدًا الآن رغم تأجيل الذهب؟ افتراضيًا لا
  // (كل شيء آجل)، مطابقةً لحالة الفورم الابتدائية في الفرونت إند.
  const payFeesNow = paymentMethod === "deferred" ? !!body.payFeesNow : false;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: supplierRows } = await client.query(
        "select id, name from suppliers where id = $1 and branch_id = $2",
        [supplierId, req.auth.branchId]
      );
      if (!supplierRows[0]) return { error: "supplier_not_found" };
      const supplier = supplierRows[0];

      let office = null;
      if (paymentMethod === "office") {
        const { rows: officeRows } = await client.query(
          "select id, name from taskir_offices where id = $1 and branch_id = $2",
          [officeId, req.auth.branchId]
        );
        if (!officeRows[0]) return { error: "office_not_found" };
        office = officeRows[0];
      }

      // يوم عمل مفتوح (إن وُجد) يُربط للتقارير اليومية فقط — لا نمنع
      // الشراء بدونه، لأن AddPurchaseModal/createLotCore في المرجع لا
      // يتحقق من ذلك إطلاقًا (خلافًا للبيع، الذي يفرضه schema.sql عبر
      // sales.business_day_id NOT NULL).
      const { rows: dayRows } = await client.query(
        `select id from business_days where branch_id = $1 and status = 'open'
          order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDayId = dayRows[0]?.id || null;

      // ── السداد بالكسر: تحقق من كفاية "وعاء" الكسر المتاح لهذا العيار.
      // ⚠ تصحيح صريح بعد سؤالك: هذا لم يعد رصيدًا مُجمَّعًا من
      // gold_ledger_entries — تلك أرقام محاسبية، لا مخزون قابل للتخصيص.
      // المصدر الصحيح هو نفسه الذي بنته endpoints الكسر (scrap.routes.js):
      // قطع scrap_items التي وصلت stage='in_safe' فعليًا (عبر break-stones
      // أو receive)، كل واحدة تحمل weight_remaining قابلاً للاستهلاك جزئيًا.
      // القرار المتفق عليه: وعاء قابل للانقسام بالوزن لكل عيار، يُستهلك
      // FIFO حسب لحظة وصول كل قطعة للخزنة (broken_at للمسار السريع، أو
      // confirmed_at لمسار المراجعة الإدارية).
      let scrapPoolRows = [];
      if (paymentMethod === "scrap") {
        const { rows: poolRows } = await client.query(
          `select id, ref, weight_remaining
             from scrap_items
            where branch_id = $1 and stage = 'in_safe' and karat_final = $2
              and weight_remaining > 0.0005
            order by coalesce(broken_at, confirmed_at, created_at) asc
            for update`,
          [req.auth.branchId, scrapKarat]
        );
        const available = poolRows.reduce((a, r) => a + Number(r.weight_remaining), 0);
        if (scrapWeight > available + 0.0005) {
          return {
            error: "insufficient_scrap_stock",
            karat: scrapKarat,
            available,
            requested: scrapWeight,
          };
        }
        scrapPoolRows = poolRows;
      }

      // ── حساب الأسطر ──
      const built = lines.map((l) => {
        const karat = Number(l.karat);
        const weight = Number(l.weight);
        const costPerGram = Number(l.costPerGram);
        const workmanshipTotal = roundMoney(l.workmanshipTotal);
        const goldCost = roundMoney(weight * costPerGram);
        const totalCost = roundMoney(goldCost + workmanshipTotal);
        return { karat, weight, costPerGram, workmanshipTotal, goldCost, totalCost };
      });

      const subtotal = roundMoney(built.reduce((a, l) => a + l.goldCost, 0));
      const workmanshipTotalSum = roundMoney(built.reduce((a, l) => a + l.workmanshipTotal, 0));
      const grandTotal = roundMoney(subtotal + workmanshipTotalSum);
      const totalWeight = built.reduce((a, l) => a + l.weight, 0);
      const totalFineWeight = built.reduce((a, l) => a + fineWeight(l.weight, l.karat), 0);

      // ── رأس الشراء ──
      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from purchases where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `PUR-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: purchaseRows } = await client.query(
        `insert into purchases
           (branch_id, ref, supplier_id, business_day_id, payment_method, office_id,
            scrap_karat, scrap_weight, pay_fees_now, invoice_pending, notes,
            subtotal, workmanship_total, grand_total, total_weight, total_fine_weight,
            created_by)
         values ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11, $12,$13,$14,$15,$16, $17)
         returning id, ref`,
        [
          req.auth.branchId, ref, supplierId, businessDayId, paymentMethod, officeId || null,
          scrapKarat, scrapWeight, payFeesNow, body.invoicePending !== false, notes || null,
          subtotal, workmanshipTotalSum, grandTotal, totalWeight, totalFineWeight,
          req.auth.userId,
        ]
      );
      const purchase = purchaseRows[0];

      // ── أسطر lots (كل عيار = دفعة/lot مستقلة، بلا كود قطع بعد) ──
      for (const l of built) {
        await client.query(
          `insert into lots
             (branch_id, purchase_id, ref, supplier_id, date, karat, weight, cost_per_gram,
              gold_cost, workmanship_total, total_cost, status, created_by)
           values ($1,$2,$3,$4, current_date, $5,$6,$7, $8,$9,$10, 'open', $11)`,
          [
            req.auth.branchId, purchase.id, purchase.ref, supplierId,
            l.karat, l.weight, l.costPerGram, l.goldCost, l.workmanshipTotal, l.totalCost,
            req.auth.userId,
          ]
        );
      }

      const label = `شراء من مورد ${supplier.name}`;

      // ── دفتر الوزن: القطع المشتراة تدخل 1210 دائمًا ──
      // من=null في كل طرق الدفع ما عدا السداد بالكسر (from='1230' لوزن
      // الكسر نفسه، وليس لوزن القطع المشتراة — سطر منفصل أدناه).
      for (const l of built) {
        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'purchase',$3,$4,$5, $6,$7, 'purchases',$8,$9,$10)`,
          [
            req.auth.branchId, businessDayId, l.karat, l.weight, fineWeight(l.weight, l.karat),
            null, "1210", purchase.id, `${label} — ${purchase.ref}`, req.auth.userId,
          ]
        );
      }

      // ── طريقة السداد ──
      let purchaseJournalEntryId = null;
      let workmanshipJournalEntryId = null;

      if (paymentMethod === "safe_cash" || paymentMethod === "safe_network") {
        const method = paymentMethod === "safe_cash" ? "cash" : "network";
        const creditAccount = paymentMethod === "safe_cash" ? "1110" : "1120";
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'safe',$3,'out',$4,'gold_purchase_supplier','purchases',$5,$6,$7)`,
          [req.auth.branchId, businessDayId, method, grandTotal, purchase.id, `${label} — ${purchase.ref}`, req.auth.userId]
        );
        purchaseJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: paymentMethod === "safe_cash" ? "purchase_cash" : "purchase_network",
          refTable: "purchases",
          refId: purchase.id,
          description: `${label} — ${purchase.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "5110", side: "debit", amount: grandTotal },
            { account: creditAccount, side: "credit", amount: grandTotal },
          ],
        });
      } else if (paymentMethod === "deferred") {
        // الذهب دائمًا آجل بالكامل. الأجور فقط تتفرّع: تُسدَّد الآن نقدًا
        // (مُقتطعة من هذا القيد وتُنقل لقيد workmanship_paid منفصل تمامًا
        // بحساب 5210 المخصَّص) أو تبقى ضمن قيد purchase_deferred نفسه
        // كالتزام على 2120 — البُعدان (ذهب/أجور) لا يُخلطان أبدًا.
        const debitTotal = payFeesNow ? subtotal : grandTotal;
        const feesLiability = payFeesNow ? 0 : workmanshipTotalSum;
        purchaseJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "purchase_deferred",
          refTable: "purchases",
          refId: purchase.id,
          description: `${label} — ${purchase.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "5110", side: "debit", amount: debitTotal },
            { account: "2110", side: "credit", amount: subtotal },
            { account: "2120", side: "credit", amount: feesLiability },
          ],
        });
        await client.query(
          `insert into supplier_ledger
             (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'increase',$4,$5,'purchases',$6,$7,$8)`,
          [
            req.auth.branchId, supplierId, businessDayId, totalFineWeight, feesLiability,
            purchase.id, `${label} — ${purchase.ref}`, req.auth.userId,
          ]
        );
        if (payFeesNow && workmanshipTotalSum > 0) {
          await client.query(
            `insert into cash_tx
               (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'safe','cash','out',$3,'gold_workmanship','purchases',$4,$5,$6)`,
            [req.auth.branchId, businessDayId, workmanshipTotalSum, purchase.id, `${label} — أجور`, req.auth.userId]
          );
          workmanshipJournalEntryId = await postJournalEntry(client, {
            branchId: req.auth.branchId,
            businessDayId,
            opType: "workmanship_paid",
            refTable: "purchases",
            refId: purchase.id,
            description: `${label} — أجور`,
            createdBy: req.auth.userId,
            lines: [
              { account: "5210", side: "debit", amount: workmanshipTotalSum },
              { account: "1110", side: "credit", amount: workmanshipTotalSum },
            ],
          });
        }
      } else if (paymentMethod === "office") {
        purchaseJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "purchase_office",
          refTable: "purchases",
          refId: purchase.id,
          description: `${label} — ${purchase.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "5110", side: "debit", amount: grandTotal },
            { account: "2130", side: "credit", amount: grandTotal },
          ],
        });
        // سطر taskir_office_tx لكل عيار على حدة — نفس فلسفة سطور lots،
        // بدل ضغط كل العيارات في وزن/عيار واحد يفقد الدقة.
        // الاتجاه 'in' = التزام تجاه المكتب يزيد (شراء جديد بتسكيره).
        for (const l of built) {
          await client.query(
            `insert into taskir_office_tx
               (branch_id, office_id, business_day_id, direction, amount, weight, karat, ref_table, ref_id, note, created_by)
             values ($1,$2,$3,'in',$4,$5,$6,'purchases',$7,$8,$9)`,
            [
              req.auth.branchId, officeId, businessDayId, l.totalCost,
              fineWeight(l.weight, l.karat), l.karat, purchase.id, `${label} — ${purchase.ref}`,
              req.auth.userId,
            ]
          );
        }
      } else if (paymentMethod === "scrap") {
        // سطر دفتر وزن منفصل تمامًا لخروج الكسر المدفوع — عيار ووزن
        // الكسر مستقلان عن عيار ووزن القطع المشتراة (لا تحقق رابط بينهما
        // في المرجع، فلا نفترض تطابقهما هنا).
        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'purchase_scrap_pay',$3,$4,$5, '1230',null, 'purchases',$6,$7,$8)`,
          [
            req.auth.branchId, businessDayId, scrapKarat, scrapWeight,
            fineWeight(scrapWeight, scrapKarat), purchase.id, `${label} — سداد بالكسر`, req.auth.userId,
          ]
        );

        // ── استهلاك الوعاء FIFO ──
        // القطع كانت مقفولة (for update) في تحقق الكفاية أعلاه؛ الآن
        // نُنقص weight_remaining فعليًا من الأقدم فالأحدث حتى نستوفي
        // scrapWeight، ونُغلق أي قطعة استُهلكت بالكامل (stage='used').
        let remainingToConsume = scrapWeight;
        for (const row of scrapPoolRows) {
          if (remainingToConsume <= 0.0005) break;
          const rowRemaining = Number(row.weight_remaining);
          const take = Math.min(rowRemaining, remainingToConsume);
          const newRemaining = roundWeight(rowRemaining - take);
          const nowUsed = newRemaining <= 0.0005;
          await client.query(
            `update scrap_items
                set weight_remaining = $1, stage = case when $2 then 'used' else stage end
              where id = $3`,
            [nowUsed ? 0 : newRemaining, nowUsed, row.id]
          );
          remainingToConsume = roundWeight(remainingToConsume - take);
        }
        // لا قيد يومية للجزء المسدَّد بالكسر: مقايضة ذهب بذهب، لا نقد
        // يتحرك (cash: null في purchase_scrap_pay بـchart.js) — دفتر
        // الوزن وحده يكفي هنا، تمامًا كفلسفة استقلال الدفترين.
        if (workmanshipTotalSum > 0) {
          // الأجور تُدفع نقدًا دائمًا في هذا المسار (لا toggle هنا خلافًا
          // للآجل) — ملاحظة chart.js صريحة بهذا.
          await client.query(
            `insert into cash_tx
               (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'safe','cash','out',$3,'gold_workmanship','purchases',$4,$5,$6)`,
            [req.auth.branchId, businessDayId, workmanshipTotalSum, purchase.id, `${label} — أجور`, req.auth.userId]
          );
          workmanshipJournalEntryId = await postJournalEntry(client, {
            branchId: req.auth.branchId,
            businessDayId,
            opType: "workmanship_paid",
            refTable: "purchases",
            refId: purchase.id,
            description: `${label} — أجور`,
            createdBy: req.auth.userId,
            lines: [
              { account: "5210", side: "debit", amount: workmanshipTotalSum },
              { account: "1110", side: "credit", amount: workmanshipTotalSum },
            ],
          });
        }
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'purchases',$3,$4)`,
        [req.auth.branchId, req.auth.userId, purchase.id, JSON.stringify({ ref: purchase.ref, grandTotal, paymentMethod })]
      );

      return {
        purchase: { id: purchase.id, ref: purchase.ref, grandTotal, totalWeight, totalFineWeight, paymentMethod },
        purchaseJournalEntryId,
        workmanshipJournalEntryId,
      };
    });

    if (result.error) {
      const status = result.error.endsWith("_not_found") ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    if (typeof err.message === "string" && err.message.startsWith("journal_entry_unbalanced")) {
      console.error("BUG: purchase produced an unbalanced journal entry:", err.message);
    }
    next(err);
  }
});

/**
 * POST /api/suppliers  { name, phone?, isOfficial? }
 *
 * ⚠ ثغرة حقيقية مكتشفة: SuppliersSubPage.jsx (الفرونت إند) كان يضيف
 * المورد عبر persistSuppliers فقط — كتابة محلية في window.storage لا
 * تصل الباك إند إطلاقًا. النتيجة: المورد يظهر فورًا في الشاشة (state
 * محلي)، وأي عملية شراء عليه تُبنى بمعرّف (id) لا وجود له في جدول
 * suppliers الحقيقي. عند أي refresh/دخول جديد يُعاد استدعاء
 * loadBootstrap() الذي يستبدل suppliers بالكامل بما يرجعه الخادم فعليًا
 * (bootstrap.routes.js) — فيختفي المورد المحلي، ومعه أي دفعة/شراء بُني
 * عليه. هذا الـendpoint يسدّ الفجوة: يُدرج المورد فعليًا في قاعدة
 * البيانات بنفس شكل استجابة bootstrap (id/ref/name/phone/isOfficial)
 * ليستبدل به الفرونت إند الكائن المحلي المؤقت.
 */
router.post("/suppliers", authenticate, requirePage("suppliers"), requireNotDenied("purchase"), async (req, res, next) => {
  const body = req.body || {};
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const isOfficial = !!body.isOfficial;

  if (!name) {
    return res.status(400).json({ error: "name_required" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: dupRows } = await client.query(
        `select id from suppliers where branch_id = $1 and lower(trim(name)) = lower(trim($2))`,
        [req.auth.branchId, name]
      );
      if (dupRows[0]) return { error: "supplier_name_exists" };

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from suppliers where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `SUP-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: supplierRows } = await client.query(
        `insert into suppliers (branch_id, ref, name, phone, is_official, created_by)
         values ($1,$2,$3,$4,$5,$6)
         returning id, ref, name, phone, is_official, created_at`,
        [req.auth.branchId, ref, name, phone || null, isOfficial, req.auth.userId]
      );
      const supplier = supplierRows[0];

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'suppliers',$3,$4)`,
        [req.auth.branchId, req.auth.userId, supplier.id, JSON.stringify({ ref: supplier.ref, name: supplier.name })]
      );

      return {
        supplier: {
          id: supplier.id,
          ref: supplier.ref,
          name: supplier.name,
          phone: supplier.phone || "",
          isOfficial: !!supplier.is_official,
          createdAt: supplier.created_at,
        },
      };
    });

    if (result.error) {
      const status = result.error === "supplier_name_exists" ? 409 : 400;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
