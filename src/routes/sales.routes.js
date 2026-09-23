import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { extractInclusiveTax } from "../domain/money.js";
import { fineWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { getOpenBusinessDay, insertSaleLines, isStocktakeLocked, postGoldMovement, reserveSaleLines } from "../domain/saleOps.js";

const router = Router();

// ⚠ لازم تحديد المسار "/sales" هنا صراحةً، لا router.use(authenticate,...)
// مجردة: كل ملفات الـroutes مركّبة على نفس البادئة app.use("/api", ...)،
// فبدون تحديد المسار كانت هذي البوابة (ومثلها في users.routes.js) تعمل
// لأي طلب يمرّ على /api/* بصرف النظر عن أي router فعليًا يخدمه — يعني
// طلب لـ/api/purchases كان يُرفض بسبب صلاحية "access" (بوابة users.routes)
// قبل ما يصل أصلًا لبوابة "purchases" الصحيحة هنا. اكتُشفت هذي الثغرة
// أثناء اختبار endpoint الشراء بمستخدم دوره "موظف" لا "مدير" (المدير يملك
// كل الصلاحيات فلم تكشفها اختباراته). التصحيح: قصر كل بوابة على مسارها.
router.use("/sales", authenticate, requirePage("sales"), requireNotDenied("sale"));

const PAYMENT_METHODS = ["cash", "card", "credit", "split", "trade_in"];
const KARATS = [24, 22, 21, 18, 14];

/**
 * POST /api/sales — the core "whole item" sale (cash/card/credit/split).
 *
 * Scope note: this covers the same ground as handleCreateSale in
 * GoldInventoryApp.jsx, including the "بدل بكسر" (trade-in) payment
 * method (folded in as a branch, matching the reference's own
 * architecture — trade-in is a paymentMethod variant of the same
 * handler, not a separate one). Partial-weight sales (handlePartialSale)
 * remain a separate endpoint below (POST /sales/partial), since that
 * flow shrinks an item's weight instead of marking discrete units sold
 * — different enough in shape to not share this code path.
 *
 * What this DOES fix relative to the reference: handleCreateSale never
 * calls postJournal — real sales never reached the double-entry journal,
 * only external/e-commerce invoices did (see the AskUserQuestion this
 * was flagged with). This endpoint posts the journal entry for every
 * sale, and — since split payments split money across two accounts
 * (1130 cash-daily and 1140 network-daily) — debits each pool for its
 * actual share instead of reusing the single-account "sale_cash"
 * shortcut the reference falls back to for weight postings. The
 * network fee, once the journal is real, gets its own proper entry too
 * (debit 6500 expense / credit 1140), so cash_tx and the trial balance
 * can't drift apart the way they structurally could before.
 */
router.post("/sales", async (req, res, next) => {
  const body = req.body || {};
  const { paymentMethod, cardNetwork, customerId } = body;
  const lines = Array.isArray(body.lines) ? body.lines : [];

  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: "invalid_payment_method" });
  }
  if (!lines.length) {
    return res.status(400).json({ error: "no_lines" });
  }
  for (const l of lines) {
    if (!l.itemId || !(Number(l.quantity) > 0) || !(Number(l.unitPrice) > 0)) {
      return res.status(400).json({ error: "invalid_line", line: l });
    }
  }
  if (paymentMethod === "credit" && !customerId) {
    return res.status(400).json({ error: "credit_sale_requires_customer" });
  }
  let cashPart = 0;
  let networkPart = 0;
  if (paymentMethod === "split") {
    cashPart = Number(body.cashPart) || 0;
    networkPart = Number(body.networkPart) || 0;
    if (cashPart <= 0 && networkPart <= 0) {
      return res.status(400).json({ error: "split_sale_requires_amounts" });
    }
  }

  // ── بدل بكسر (Trade-in) — راجع النطاق والقرارات في التعليق أعلى القيد
  // المزدوج أدناه. مثل NewSaleModal في المرجع: "بدل بكسر بلا سطر كسر
  // ليس بدلًا" — لازم سطر واحد على الأقل.
  const tradeLines = Array.isArray(body.tradeLines) ? body.tradeLines : [];
  if (paymentMethod === "trade_in" && !tradeLines.length) {
    return res.status(400).json({ error: "trade_in_requires_lines" });
  }
  const builtTradeLines = [];
  if (paymentMethod === "trade_in") {
    for (const l of tradeLines) {
      const karat = Number(l.karat);
      const gross = l.grossWeight != null ? Number(l.grossWeight) : null;
      const net = Number(l.netWeight);
      if (!KARATS.includes(karat) || !(net > 0)) {
        return res.status(400).json({ error: "invalid_trade_line", line: l });
      }
      if (gross != null && gross < net - 0.0005) {
        return res.status(400).json({ error: "trade_line_gross_less_than_net", line: l });
      }
      const total = l.total != null
        ? Math.round(Number(l.total) * 100) / 100
        : Math.round(net * Number(l.pricePerGram || 0) * 100) / 100;
      if (!(total > 0)) {
        return res.status(400).json({ error: "invalid_trade_line", line: l });
      }
      const pricePerGram = net > 0 ? Math.round((total / net) * 10000) / 10000 : 0;
      const stonesMargin = Math.max(0, Math.round(((gross ?? net) - net) * 1000) / 1000);
      builtTradeLines.push({ karat, gross: gross ?? net, net, total, pricePerGram, stonesMargin });
    }
  }
  const tradeInValue = Math.round(builtTradeLines.reduce((a, l) => a + l.total, 0) * 100) / 100;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      // ⚠ لا بيع أثناء الجرد — نفس حارس stocktakeLock في handleCreateSale.
      if (await isStocktakeLocked(client, req.auth.branchId)) return { error: "stocktake_locked" };

      // يوم عمل مفتوح إلزامي — sales.business_day_id NOT NULL في الـschema.
      const businessDay = await getOpenBusinessDay(client, req.auth.branchId);
      if (!businessDay) return { error: "no_open_business_day" };

      const { rows: settingsRows } = await client.query(
        "select tax_enabled, tax_rate, card_fees from branch_settings where branch_id = $1",
        [req.auth.branchId]
      );
      const settings = settingsRows[0] || { tax_enabled: true, tax_rate: 0.15, card_fees: {} };
      const taxApplicable =
        body.taxApplicable != null ? !!body.taxApplicable : settings.tax_enabled;

      // ── تحميل القطع والتحقق من التوفر، وحجز الأسطر ──
      const reserved = await reserveSaleLines(client, req.auth.branchId, lines);
      if (reserved.error) return reserved;
      const { resolvedLines, subtotal, weightByKarat } = reserved;

      const total = Math.round(subtotal * 100) / 100;
      const taxRate = taxApplicable ? Number(settings.tax_rate) : 0;
      const taxAmount = taxApplicable ? extractInclusiveTax(total, taxRate) : 0;
      const netAmount = Math.round((total - taxAmount) * 100) / 100;

      if (paymentMethod === "split") {
        const sumParts = Math.round((cashPart + networkPart) * 100) / 100;
        if (sumParts !== total) {
          return { error: "split_amounts_do_not_match_total", total, sumParts };
        }
      }

      // ── الفاتورة نفسها ──
      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from sales where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `SALE-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: saleRows } = await client.query(
        `insert into sales
           (branch_id, ref, business_day_id, customer_id, payment_method,
            price24_snapshot, card_network, cash_part, network_part, trade_in_value,
            subtotal, total, tax_applicable, tax_rate, tax_amount, net_amount,
            seller_id, created_by)
         values ($1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13,$14,$15, $16,$17,$17)
         returning id, ref`,
        [
          req.auth.branchId, ref, businessDay.id, customerId || null, paymentMethod,
          body.price24Snapshot || 0, cardNetwork || null, cashPart, networkPart, tradeInValue,
          subtotal, total, taxApplicable, taxRate, taxAmount, netAmount,
          req.auth.userId,
        ]
      );
      const sale = saleRows[0];

      // ── بدل بكسر: إنشاء قطع scrap_items فعلية (لا مستند منفصل مبسَّط) —
      // تدخل بنفس مراحل SCRAP_STAGES الموجودة أصلًا (pending_break/in_box)
      // بالضبط كأي شراء كسر عادي، فتُكمل لاحقًا نفس مسار scrap.routes.js
      // (استلام/تكسير أو إرسال/تقييم/اعتماد/استلام) — لا اختصار لمرحلة
      // نهائية كما قد يُظن. مصدرها (source='trade_in') يُميّزها في
      // التقارير عن شراء الكسر المعتاد من عداد scrapIntake.
      const scrapItemIds = [];
      if (paymentMethod === "trade_in") {
        // ⚠ ملاحظة مهمة: scrap_items ليس فيها عمود customer_id (فقط
        // customer_name نصي حرّ — migration 005). خلافًا لجدول sales الذي
        // فيه customer_id (FK حقيقي). هنا نجلب الاسم إن وُجد customerId
        // لعرضه في تقارير الكسر تمامًا كأي شراء كسر عادي، والربط الحقيقي
        // بالعميل يبقى عبر sale_id → sales.customer_id.
        let customerName = null;
        if (customerId) {
          const { rows: custRows } = await client.query(
            `select name from customers where id = $1 and branch_id = $2`,
            [customerId, req.auth.branchId]
          );
          customerName = custRows[0]?.name || null;
        }
        for (const l of builtTradeLines) {
          const stage = l.stonesMargin > 0.0005 ? "pending_break" : "in_box";
          const { rows: refRows2 } = await client.query(
            `select count(*)::int + 1 as n from scrap_items where branch_id = $1`,
            [req.auth.branchId]
          );
          const scrapRef = `SCR-${String(refRows2[0].n).padStart(6, "0")}`;
          const { rows: siRows } = await client.query(
            `insert into scrap_items
               (branch_id, ref, karat_est, weight_est, gross_weight, stones_margin_est,
                price_per_gram, total_paid, payment_method, stage, source, sale_id,
                customer_name, business_day_id, created_by)
             values ($1,$2,$3,$4,$5,$6, $7,$8,'trade_in',$9,'trade_in',$10, $11,$12,$13)
             returning id`,
            [
              req.auth.branchId, scrapRef, l.karat, l.net, l.gross, l.stonesMargin,
              l.pricePerGram, l.total, stage, sale.id,
              customerName, businessDay.id, req.auth.userId,
            ]
          );
          scrapItemIds.push(siRows[0].id);

          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,'trade_in_scrap_buy',$3,$4,$5, null,'1230', 'scrap_items',$6,$7,$8)`,
            [req.auth.branchId, businessDay.id, l.karat, l.net, fineWeight(l.net, l.karat), siRows[0].id, `بدل بكسر — فاتورة ${sale.ref}`, req.auth.userId]
          );
        }
      }

      // ⚠ line_no يُثبَّت صراحةً (migration 013) — راجع insertSaleLines.
      await insertSaleLines(client, sale.id, resolvedLines);

      // ── دفتر الوزن: الذهب يخرج من 1210 (مشغول جاهز للبيع) ──
      await postGoldMovement(client, {
        branchId: req.auth.branchId, businessDayId: businessDay.id, opType: "sale",
        weightByKarat, refTable: "sales", refId: sale.id, note: `بيع ${sale.ref}`, createdBy: req.auth.userId,
      });

      // ── الصندوق ──
      let fee = 0;
      const feePct = cardNetwork ? Number(settings.card_fees?.[cardNetwork]) || 0 : 0;

      if (paymentMethod === "cash") {
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily','cash','in',$3,'sales_revenue','sales',$4,$5,$6)`,
          [req.auth.branchId, businessDay.id, total, sale.id, `بيع ${sale.ref}`, req.auth.userId]
        );
      } else if (paymentMethod === "card") {
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily','network','in',$3,'sales_revenue','sales',$4,$5,$6)`,
          [req.auth.branchId, businessDay.id, total, sale.id, `بيع ${sale.ref}`, req.auth.userId]
        );
        fee = Math.round(total * (feePct / 100) * 100) / 100;
        if (fee > 0) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','network','out',$3,'network_fees','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, fee, sale.id, `عمولة شبكة ${sale.ref}`, req.auth.userId]
          );
        }
      } else if (paymentMethod === "split") {
        if (cashPart > 0) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','cash','in',$3,'sales_revenue','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, cashPart, sale.id, `بيع ${sale.ref}`, req.auth.userId]
          );
        }
        if (networkPart > 0) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','network','in',$3,'sales_revenue','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, networkPart, sale.id, `بيع ${sale.ref}`, req.auth.userId]
          );
          fee = Math.round(networkPart * (feePct / 100) * 100) / 100;
          if (fee > 0) {
            await client.query(
              `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
               values ($1,$2,'daily','network','out',$3,'network_fees','sales',$4,$5,$6)`,
              [req.auth.branchId, businessDay.id, fee, sale.id, `عمولة شبكة ${sale.ref}`, req.auth.userId]
            );
          }
        }
      }
      // credit: no cash movement — the customer receivable is what the
      // journal's debit line represents instead (below).

      // ── بدل بكسر: الفرق فقط (لا الإجمالي) يتحرك نقدًا ──
      // diff > 0: العميل يدفع الباقي نقدًا (قيمة الكسر أقل من الفاتورة).
      // diff < 0: نرجع له الفرق نقدًا (قيمة الكسر أعلى من الفاتورة).
      // |diff| ضمن هامش السنتات: لا حركة نقد إطلاقًا (مطابقة تمامًا =
      // مقاصة كاملة). راجع قرارك الصريح أعلى migration 007.
      let tradeInDiff = 0;
      if (paymentMethod === "trade_in") {
        tradeInDiff = Math.round((total - tradeInValue) * 100) / 100;
        if (tradeInDiff > 0.005) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','cash','in',$3,'sales_revenue','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, tradeInDiff, sale.id, `فرق بدل بكسر — فاتورة ${sale.ref}`, req.auth.userId]
          );
        } else if (tradeInDiff < -0.005) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','cash','out',$3,'gold_purchase_scrap','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, Math.abs(tradeInDiff), sale.id, `فرق بدل بكسر (إرجاع) — فاتورة ${sale.ref}`, req.auth.userId]
          );
        }
      }

      // ── القيد المزدوج — النقطة اللي كانت مفقودة تمامًا في المرجع ──
      const creditLines = [];
      if (taxAmount > 0) {
        creditLines.push({ account: "4140", side: "credit", amount: netAmount });
        creditLines.push({ account: "2220", side: "credit", amount: taxAmount });
      } else {
        creditLines.push({ account: "4140", side: "credit", amount: total });
      }

      const debitLines = [];
      if (paymentMethod === "cash") {
        debitLines.push({ account: "1130", side: "debit", amount: total });
      } else if (paymentMethod === "card") {
        debitLines.push({ account: "1140", side: "debit", amount: total });
      } else if (paymentMethod === "credit") {
        debitLines.push({ account: "1310", side: "debit", amount: total });
      } else if (paymentMethod === "split") {
        if (cashPart > 0) debitLines.push({ account: "1130", side: "debit", amount: cashPart });
        if (networkPart > 0) debitLines.push({ account: "1140", side: "debit", amount: networkPart });
      } else if (paymentMethod === "trade_in") {
        // مدين 1230 بقيمة الكسر النقدية (حساب "both": نقدي ووزني معًا) +
        // مدين/دائن 1130 بالفرق فقط — ضمن نفس قيد الفاتورة، لا قيد منفصل.
        if (tradeInValue > 0.005) {
          debitLines.push({ account: "1230", side: "debit", amount: tradeInValue });
        }
        if (tradeInDiff > 0.005) {
          debitLines.push({ account: "1130", side: "debit", amount: tradeInDiff });
        } else if (tradeInDiff < -0.005) {
          creditLines.push({ account: "1130", side: "credit", amount: Math.abs(tradeInDiff) });
        }
      }

      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId: businessDay.id,
        opType:
          paymentMethod === "credit" ? "sale_credit" :
          paymentMethod === "card" ? "sale_card" :
          paymentMethod === "trade_in" ? "sale_trade_in" :
          "sale_cash",
        refTable: "sales",
        refId: sale.id,
        description: `فاتورة ${sale.ref}`,
        createdBy: req.auth.userId,
        lines: [...debitLines, ...creditLines],
      });

      let feeJournalEntryId = null;
      if (fee > 0) {
        feeJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId: businessDay.id,
          opType: "network_fee",
          refTable: "sales",
          refId: sale.id,
          description: `عمولة شبكة ${sale.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "6500", side: "debit", amount: fee },
            { account: "1140", side: "credit", amount: fee },
          ],
        });
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'sales',$3,$4)`,
        [req.auth.branchId, req.auth.userId, sale.id, JSON.stringify({ ref: sale.ref, total, paymentMethod })]
      );

      return {
        sale: { id: sale.id, ref: sale.ref, total, taxAmount, netAmount, paymentMethod },
        journalEntryId,
        feeJournalEntryId,
        ...(paymentMethod === "trade_in"
          ? { tradeInValue, tradeInDiff, scrapItemIds }
          : {}),
      };
    });

    if (result.error) {
      const status = result.error === "item_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    if (typeof err.message === "string" && err.message.startsWith("journal_entry_unbalanced")) {
      // Should be unreachable if the logic above is correct — surfaced as
      // a 500 deliberately (this is a bug, not a user input problem) but
      // with the specific reason logged for whoever investigates.
      console.error("BUG: sale produced an unbalanced journal entry:", err.message);
    }
    next(err);
  }
});

/**
 * POST /api/sales/partial — البيع الجزئي (بالوزن)، يقابل handlePartialSale
 * في المرجع. يُباع وزن جزئي من صنف category.sale_mode==='partial' بدل
 * وحدة كاملة: يُنقَص item.weight (ونصيبه من lot_workmanship_share
 * تناسبيًا)، وإذا اقترب المتبقي من الصفر (استُنفد الصنف بالكامل) تُعلَّم
 * كل item_units التابعة له sold=true — هذا هو "إغلاق" الصنف؛ السطر نفسه
 * لا يُحذف أبدًا.
 *
 * ⚠ قرارك الصريح: الإعفاء الضريبي دائم ومطلَق هنا (taxApplicable=false
 * ثابتًا، لا حقل اختياري) — مطابقة لِـPartialSaleModal في المرجع الذي لا
 * يعرض توگل ضريبة إطلاقًا لهذا النوع من البيع.
 *
 * ⚠ إصلاح حقيقي (بنفس نمط endpoint البيع الرئيسي أعلاه): posting_rules
 * 'sale_partial' في seed.sql يحدّد حساب مدين ثابت (1130) بصرف النظر عن
 * طريقة الدفع الفعلية — قاعدة ميتة فعليًا في المرجع لأن postJournal لا
 * يُستدعى إطلاقًا لهذا المسار هناك. هنا نبني القيد الفعلي في الكود
 * (نفس أسلوب البيع الرئيسي): 1130 نقدًا، 1140 شبكة، لا قيد نقدي لآجل
 * (1310 مدينة فقط، بلا حركة cash_tx).
 */
router.post("/sales/partial", async (req, res, next) => {
  const body = req.body || {};
  const { itemId, customerId, cardNetwork } = body;
  const paymentMethod = body.paymentMethod;
  const sellWeight = Number(body.sellWeight);
  const unitPrice = Number(body.unitPrice); // price per gram

  const PARTIAL_PAYMENT_METHODS = ["cash", "card", "credit"];
  if (!itemId) {
    return res.status(400).json({ error: "item_id_required" });
  }
  if (!PARTIAL_PAYMENT_METHODS.includes(paymentMethod)) {
    return res.status(400).json({ error: "invalid_payment_method" });
  }
  if (!(sellWeight > 0)) {
    return res.status(400).json({ error: "invalid_sell_weight" });
  }
  if (!(unitPrice > 0)) {
    return res.status(400).json({ error: "invalid_unit_price" });
  }
  if (paymentMethod === "credit" && !customerId) {
    return res.status(400).json({ error: "credit_sale_requires_customer" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: lockRows } = await client.query(
        "select locked from stocktake_locks where branch_id = $1",
        [req.auth.branchId]
      );
      if (lockRows[0]?.locked) return { error: "stocktake_locked" };

      const { rows: dayRows } = await client.query(
        `select id, ref from business_days
          where branch_id = $1 and status = 'open'
          order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDay = dayRows[0];
      if (!businessDay) return { error: "no_open_business_day" };

      const { rows: itemRows } = await client.query(
        `select i.*, c.sale_mode, c.min_sale_weight
           from items i join categories c on c.id = i.category_id
          where i.id = $1 and i.branch_id = $2
          for update of i`,
        [itemId, req.auth.branchId]
      );
      const item = itemRows[0];
      if (!item) return { error: "item_not_found", itemId };
      if (item.sale_mode !== "partial") {
        return { error: "item_is_not_partial_sale_mode", itemId };
      }

      const available = Number(item.weight);
      // هامش 0.5 ملغم — نفس epsilon المستخدم في كل مقارنات الوزن بالمشروع.
      if (sellWeight > available + 0.0005) {
        return { error: "insufficient_weight", available, requested: sellWeight };
      }

      const remaining = Math.round((available - sellWeight) * 1000) / 1000;
      const soldOut = remaining <= 0.0005;

      // حد أدنى للبيع (min_sale_weight) — يُتجاوَز فقط إذا كان البيع
      // يستنفد الصنف بالكامل (soldOut) تمامًا كما في PartialSaleModal:
      // بيع "الباقي كله" مسموح حتى لو أقل من الحد الأدنى المعتاد.
      const minSaleWeight = item.min_sale_weight != null ? Number(item.min_sale_weight) : 0;
      if (!soldOut && minSaleWeight > 0 && sellWeight < minSaleWeight - 0.0005) {
        return { error: "below_min_sale_weight", minSaleWeight, requested: sellWeight };
      }

      const ratio = available > 0 ? sellWeight / available : 0;
      const wmShare = Math.round(Number(item.lot_workmanship_share || 0) * ratio * 100) / 100;
      const remainingWmShare =
        Math.round((Number(item.lot_workmanship_share || 0) - wmShare) * 100) / 100;

      await client.query(
        `update items set weight = $1, lot_workmanship_share = $2 where id = $3`,
        [remaining, remainingWmShare, item.id]
      );

      if (soldOut) {
        await client.query(
          `update item_units set sold = true where item_id = $1 and sold = false and issued = false`,
          [item.id]
        );
      }

      const total = Math.round(sellWeight * unitPrice * 100) / 100;
      if (!(total > 0)) {
        return { error: "invalid_computed_total" };
      }

      // ⚠ إعفاء ضريبي دائم — بقرارك الصريح، مطابقة للمرجع (لا توگل هنا
      // إطلاقًا، بعكس endpoint البيع الرئيسي أعلاه).
      const taxApplicable = false;
      const taxRate = 0;
      const taxAmount = 0;
      const netAmount = total;

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from sales where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `SALE-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: saleRows } = await client.query(
        `insert into sales
           (branch_id, ref, business_day_id, customer_id, payment_method,
            price24_snapshot, card_network, cash_part, network_part,
            subtotal, total, tax_applicable, tax_rate, tax_amount, net_amount,
            seller_id, created_by)
         values ($1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12,$13,$14, $15,$16,$16)
         returning id, ref`,
        [
          req.auth.branchId, ref, businessDay.id, customerId || null, paymentMethod,
          body.price24Snapshot || 0, cardNetwork || null,
          paymentMethod === "cash" ? total : 0, paymentMethod === "card" ? total : 0,
          total, total, taxApplicable, taxRate, taxAmount, netAmount,
          req.auth.userId,
        ]
      );
      const sale = saleRows[0];

      // ⚠ line_no = 0 دائمًا هنا: البيع الجزئي سطر واحد وحيد بحكم طبيعته
      // (قطعة قابلة للانقسام واحدة لكل عملية) — لا تعداد مطلوب.
      await client.query(
        `insert into sale_lines
           (sale_id, item_id, category, karat, quantity, unit_price,
            weight_snapshot, cost_per_gram_snapshot, workmanship_snapshot, line_no)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`,
        [
          sale.id, item.id, item.category_id, item.karat, sellWeight, unitPrice,
          sellWeight, item.cost_per_gram, wmShare,
        ]
      );

      // ── دفتر الوزن ──
      await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight,
            from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'sale_partial',$3,$4,$5, '1210',null, 'sales',$6,$7,$8)`,
        [
          req.auth.branchId, businessDay.id, item.karat, sellWeight, fineWeight(sellWeight, item.karat),
          sale.id, `بيع جزئي ${sale.ref}`, req.auth.userId,
        ]
      );

      // ── الصندوق (cash/card فقط، لا حركة نقد لآجل) ──
      let fee = 0;
      const { rows: settingsRows } = await client.query(
        "select card_fees from branch_settings where branch_id = $1",
        [req.auth.branchId]
      );
      const cardFees = settingsRows[0]?.card_fees || {};
      const feePct = cardNetwork ? Number(cardFees[cardNetwork]) || 0 : 0;

      if (paymentMethod === "cash") {
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily','cash','in',$3,'sales_revenue','sales',$4,$5,$6)`,
          [req.auth.branchId, businessDay.id, total, sale.id, `بيع جزئي ${sale.ref}`, req.auth.userId]
        );
      } else if (paymentMethod === "card") {
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily','network','in',$3,'sales_revenue','sales',$4,$5,$6)`,
          [req.auth.branchId, businessDay.id, total, sale.id, `بيع جزئي ${sale.ref}`, req.auth.userId]
        );
        fee = Math.round(total * (feePct / 100) * 100) / 100;
        if (fee > 0) {
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
             values ($1,$2,'daily','network','out',$3,'network_fees','sales',$4,$5,$6)`,
            [req.auth.branchId, businessDay.id, fee, sale.id, `عمولة شبكة ${sale.ref}`, req.auth.userId]
          );
        }
      }

      // ── القيد المزدوج — نفس إصلاح endpoint البيع الرئيسي: حساب مدين
      // فعلي حسب طريقة الدفع، لا الـ1130 الثابت في posting_rules.sale_partial ──
      const debitLines = [];
      if (paymentMethod === "cash") {
        debitLines.push({ account: "1130", side: "debit", amount: total });
      } else if (paymentMethod === "card") {
        debitLines.push({ account: "1140", side: "debit", amount: total });
      } else if (paymentMethod === "credit") {
        debitLines.push({ account: "1310", side: "debit", amount: total });
      }
      const creditLines = [{ account: "4140", side: "credit", amount: total }];

      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId: businessDay.id,
        opType: "sale_partial",
        refTable: "sales",
        refId: sale.id,
        description: `بيع جزئي ${sale.ref}`,
        createdBy: req.auth.userId,
        lines: [...debitLines, ...creditLines],
      });

      let feeJournalEntryId = null;
      if (fee > 0) {
        feeJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId: businessDay.id,
          opType: "network_fee",
          refTable: "sales",
          refId: sale.id,
          description: `عمولة شبكة ${sale.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "6500", side: "debit", amount: fee },
            { account: "1140", side: "credit", amount: fee },
          ],
        });
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'sales',$3,$4)`,
        [req.auth.branchId, req.auth.userId, sale.id, JSON.stringify({ ref: sale.ref, total, paymentMethod, sellWeight, soldOut })]
      );

      return {
        sale: { id: sale.id, ref: sale.ref, total, taxAmount: 0, netAmount: total, paymentMethod },
        journalEntryId,
        feeJournalEntryId,
        soldOut,
        remainingWeight: remaining,
      };
    });

    if (result.error) {
      const status = result.error === "item_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    if (typeof err.message === "string" && err.message.startsWith("journal_entry_unbalanced")) {
      console.error("BUG: partial sale produced an unbalanced journal entry:", err.message);
    }
    next(err);
  }
});

export default router;
