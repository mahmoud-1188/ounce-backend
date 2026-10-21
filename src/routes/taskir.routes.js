import { Router } from "express";
import { poolBalance } from "../domain/cashPools.js";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied, requireManager } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { approvalGate } from "../domain/approvals.js";

const router = Router();

// ⚠ لازم مسارات صريحة لكل واحد من الصفحتين المختلفتين اللي بتستخدم هذا
// الملف (raajع نفس التعليق في purchases.routes.js/sales.routes.js):
// "/taskirat" (TaskiratPage.jsx — إضافة/عرض تسكيرات) و"/taskir-offices"
// (TaskirOfficesPage.jsx — دفتر تسوية المكاتب) لهما صلاحيتا صفحة
// مختلفتان في allowed_more (migration 002)، فلا يصح تجميعهما تحت بادئة
// واحدة.
router.use("/taskirat", authenticate, requirePage("taskirat"), requireNotDenied("taskir"));
router.use("/taskir-offices", authenticate, requirePage("officeLedger"));

const KARATS = [24, 22, 21, 18, 14];
const GOLD_SOURCES = ["scrap", "purchased"];
const FUNDING_SOURCES = ["daily_cash", "daily_network", "safe_cash", "safe_network"];

function fundingToPoolMethod(fundingSource) {
  // ⚠ مطابق تمامًا لـFUNDING_SOURCES في core/constants.js بالفرونت إند:
  // البادئة daily_* تعني صندوق اليوم (يوم عمل مفتوح إلزامي)، safe_* تعني
  // خزنة الفرع مباشرة (لا يشترط يوم عمل).
  switch (fundingSource) {
    // ⚠ cash_tx.pool يقبل 'daily' لا 'day' (قيد CHECK) — كان كل تسكير
    //   يموَّل من الصندوق اليومي يفشل بخطأ خادم.
    case "daily_cash":
      return { pool: "daily", method: "cash" };
    case "daily_network":
      return { pool: "daily", method: "network" };
    case "safe_cash":
      return { pool: "safe", method: "cash" };
    case "safe_network":
      return { pool: "safe", method: "network" };
    default:
      return null;
  }
}

/**
 * GET /api/taskirat — قائمة سجلات التسكير (TaskiratPage.jsx).
 */
router.get("/taskirat", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query(
        `select t.*, s.name as supplier_name, o.name as office_name
           from taskir_entries t
           left join suppliers s on s.id = t.supplier_id
           left join taskir_offices o on o.id = t.office_id
          where t.branch_id = $1
          order by t.created_at desc
          limit 500`,
        [req.auth.branchId]
      )
    );
    res.json({ taskirEntries: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/taskirat — تسجيل تسكير جديد (AddTaskirForm.jsx →
 * handleAddTaskir في المرجع).
 *
 * تسوية مستحقات مورد: إما بتسليمه ذهبًا من الكسر المتوفر في الخزنة
 * (goldSource="scrap"، لا تكلفة ذهب — مقايضة ذهب بذهب)، أو بشراء ذهب خام
 * من مكتب تسكير متخصص (goldSource="purchased" — يحوّل جزء الذهب من
 * الالتزام لمورد إلى التزام لمكتب، مسجَّل في taskir_office_tx). الأجور
 * (مصنعية) تُسدَّد نقدًا دائمًا، من أي مصدر تمويل.
 *
 * في الحالتين: دين المورد (supplier_ledger) ينخفض بمقدار الوزن الصافي
 * المسدَّد — هذا هو الفرق الجوهري عن purchases.routes.js (الذي يزيد
 * الدين)، ولا وجود له في المرجع المحلي القديم (الذي لم يربط التسكير
 * بمورد أصلًا — راجع تعليق migration 011).
 */
router.post("/taskirat", async (req, res, next) => {
  const body = req.body || {};
  const { supplierId, goldSource, fundingSource, officeId, notes } = body;
  const karat = Number(body.karat);
  const weight = Number(body.weight);
  const workmanshipAmount = roundMoney(body.workmanshipAmount || 0);
  const pricePerGram = body.pricePerGram != null ? Number(body.pricePerGram) : null;

  if (!supplierId) {
    return res.status(400).json({ error: "supplier_required" });
  }
  if (!KARATS.includes(karat) || !(weight > 0)) {
    return res.status(400).json({ error: "invalid_karat_or_weight" });
  }
  if (!GOLD_SOURCES.includes(goldSource)) {
    return res.status(400).json({ error: "invalid_gold_source" });
  }
  if (goldSource === "purchased") {
    if (!officeId) return res.status(400).json({ error: "office_required" });
    if (!(pricePerGram > 0)) return res.status(400).json({ error: "invalid_price_per_gram" });
  }
  const poolMethod = fundingToPoolMethod(fundingSource);
  if (workmanshipAmount > 0 && !poolMethod) {
    return res.status(400).json({ error: "invalid_funding_source" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: supplierRows } = await client.query(
        "select id, name from suppliers where id = $1 and branch_id = $2",
        [supplierId, req.auth.branchId]
      );
      if (!supplierRows[0]) return { error: "supplier_not_found" };
      const supplier = supplierRows[0];

      if (goldSource === "purchased") {
        const { rows: officeRows } = await client.query(
          "select id from taskir_offices where id = $1 and branch_id = $2",
          [officeId, req.auth.branchId]
        );
        if (!officeRows[0]) return { error: "office_not_found" };
      }

      const { rows: dayRows } = await client.query(
        `select id from business_days where branch_id = $1 and status = 'open'
          order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDayId = dayRows[0]?.id || null;
      if (poolMethod?.pool === "daily" && !businessDayId) {
        // يوم العمل المطفأ (migration 034) يسمح بالحركة من الصندوق بلا يوم.
        const { rows: modeRows } = await client.query(
          "select workday_mode from branch_settings where branch_id = $1",
          [req.auth.branchId]
        );
        if (modeRows[0]?.workday_mode !== "off") return { error: "no_open_business_day" };
      }

      const fine = fineWeight(weight, karat);
      let scrapPoolRows = [];
      if (goldSource === "scrap") {
        // نفس فلسفة استهلاك الكسر FIFO في purchases.routes.js: وعاء
        // قابل للانقسام بالوزن لكل عيار من قطع scrap_items الواصلة
        // للخزنة (stage='in_safe')، لا رصيد محاسبي مُجمَّع.
        const { rows: poolRows } = await client.query(
          `select id, ref, weight_remaining
             from scrap_items
            where branch_id = $1 and stage = 'in_safe' and karat_final = $2
              and weight_remaining > 0.0005
            order by coalesce(broken_at, confirmed_at, created_at) asc
            for update`,
          [req.auth.branchId, karat]
        );
        const available = poolRows.reduce((a, r) => a + Number(r.weight_remaining), 0);
        if (weight > available + 0.0005) {
          return { error: "insufficient_scrap_stock", karat, available, requested: weight };
        }
        scrapPoolRows = poolRows;
      }

      const goldCost = goldSource === "purchased" ? roundMoney(weight * pricePerGram) : 0;
      const totalCashPaid = roundMoney(goldCost + workmanshipAmount);

      // ⚖ السداد الكبير للمورد يُعتمد (قاعدة supplier_settle)
      const gate = await approvalGate(client, req.auth, {
        kind: "supplier_settle", amount: totalCashPaid, approvalId: body.approvalId || null,
        note: `تسكير لمورد ${supplier.name}`, payload: { ...body, approvalId: undefined },
      });
      if (gate.error) return gate;
      if (gate.pending) return { approvalPending: gate.pending };

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from taskir_entries where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `TSK-${String(refRows[0].n).padStart(6, "0")}`;
      const label = `تسكير لمورد ${supplier.name} — ${ref}`;

      const { rows: entryRows } = await client.query(
        `insert into taskir_entries
           (branch_id, ref, supplier_id, office_id, karat, weight, gold_source,
            price_per_gram, gold_cost, workmanship_amount, funding_source,
            total_cash_paid, notes, business_day_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11, $12,$13,$14,$15)
         returning id, ref`,
        [
          req.auth.branchId, ref, supplierId, officeId || null, karat, weight, goldSource,
          pricePerGram, goldCost, workmanshipAmount, fundingSource || null,
          totalCashPaid, notes || null, businessDayId, req.auth.userId,
        ]
      );
      const entry = entryRows[0];

      // ── دفتر الوزن: الذهب يخرج من الخزنة (1220) للمورد في الحالتين ──
      await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight,
            from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'taskir_settlement',$3,$4,$5, '1220',null, 'taskir_entries',$6,$7,$8)`,
        [req.auth.branchId, businessDayId, karat, weight, fine, entry.id, label, req.auth.userId]
      );

      if (goldSource === "scrap") {
        // ── استهلاك وعاء الكسر FIFO (نفس منطق purchases.routes.js) ──
        let remainingToConsume = weight;
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
      } else {
        // ── goldSource === "purchased": الالتزام ينتقل من المورد
        // للمكتب — سطر taskir_office_tx مدين (direction='in') بنفس
        // فلسفة purchases.routes.js لطريقة الدفع "office"، مرتبط هنا
        // بـtaskir_entries لا purchases.
        await client.query(
          `insert into taskir_office_tx
             (branch_id, office_id, business_day_id, direction, kind, amount, weight, karat,
              ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'in','gold',$4,$5,$6, 'taskir_entries',$7,$8,$9)`,
          [req.auth.branchId, officeId, businessDayId, goldCost, fine, karat, entry.id, label, req.auth.userId]
        );
      }

      // ── الأجور المدفوعة هنا تسدّد أولًا أجور المورد المستحقة (2120 —
      //    قيّدتها المشتريات الآجلة مصروفًا والتزامًا)، والزائد وحده أجورٌ
      //    جديدة (5210). كانت كلها تُقيَّد 5210 فتُصرف الأجور مرتين ويبقى
      //    2120 والتزام المورد في دفتره لا يُسدَّدان أبدًا.
      let feesSettled = 0;
      if (workmanshipAmount > 0) {
        const { rows: owedRows } = await client.query(
          `select coalesce(sum(case when direction = 'increase' then fees_amount else -fees_amount end), 0) as owed
             from supplier_ledger where branch_id = $1 and supplier_id = $2`,
          [req.auth.branchId, supplierId]
        );
        feesSettled = roundMoney(Math.max(0, Math.min(workmanshipAmount, Number(owedRows[0]?.owed) || 0)));
      }

      // ── دين المورد ينخفض بمقدار الوزن الصافي المسدَّد (والأجور المسدَّدة) ──
      await client.query(
        `insert into supplier_ledger
           (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount,
            ref_table, ref_id, note, created_by)
         values ($1,$2,$3,'decrease',$4,$5,'taskir_entries',$6,$7,$8)`,
        [req.auth.branchId, supplierId, businessDayId, fine, feesSettled, entry.id, label, req.auth.userId]
      );

      // ── الأجور: نقدًا دائمًا، من مصدر التمويل المختار ──
      let workmanshipJournalEntryId = null;
      if (workmanshipAmount > 0) {
        // الحساب النقدي بحسب الوعاء: الخزنة 1110/1120 · الصندوق اليومي 1130/1140
        const creditAccount = poolMethod.pool === "daily"
          ? (poolMethod.method === "cash" ? "1130" : "1140")
          : (poolMethod.method === "cash" ? "1110" : "1120");
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,'out',$5,'gold_workmanship','taskir_entries',$6,$7,$8)`,
          [
            req.auth.branchId, businessDayId, poolMethod.pool, poolMethod.method,
            workmanshipAmount, entry.id, `${label} — أجور`, req.auth.userId,
          ]
        );
        workmanshipJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "workmanship_paid",
          refTable: "taskir_entries",
          refId: entry.id,
          description: `${label} — أجور`,
          createdBy: req.auth.userId,
          lines: [
            { account: "2120", side: "debit", amount: feesSettled },
            { account: "5210", side: "debit", amount: roundMoney(workmanshipAmount - feesSettled) },
            { account: creditAccount, side: "credit", amount: workmanshipAmount },
          ],
        });
      }

      // ── goldCost (فقط عند الشراء من مكتب): posting_rules.settle_office
      // في seed.sql صريحة — cash: null، لا نقد يتحرك هنا إطلاقًا. المكتب
      // "يسلّم الذهب للمورد نيابةً عنك، فينتقل التزامك إليه" (تعليق
      // TaskirOfficesPage.jsx): مجرد نقل التزام دفتري من حساب الموردين
      // (2110) لحساب المكاتب (2130)، بقيمة goldCost — لا خصم نقدي الآن.
      // النقد الفعلي يخرج لاحقًا فقط عند سداد المكتب نفسه (endpoint
      // /taskir-offices/:officeId/settle أدناه، الذي يقيّد 2130 وحده).
      let goldJournalEntryId = null;
      if (goldCost > 0) {
        goldJournalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "settle_office",
          refTable: "taskir_entries",
          refId: entry.id,
          description: label,
          createdBy: req.auth.userId,
          lines: [
            { account: "2110", side: "debit", amount: goldCost },
            { account: "2130", side: "credit", amount: goldCost },
          ],
        });
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'taskir_entries',$3,$4)`,
        [req.auth.branchId, req.auth.userId, entry.id, JSON.stringify({ ref: entry.ref, goldSource, totalCashPaid })]
      );

      return {
        taskirEntry: { id: entry.id, ref: entry.ref, goldSource, totalCashPaid, fine },
        workmanshipJournalEntryId,
        goldJournalEntryId,
      };
    });

    if (result.error) {
      const status = result.error.endsWith("_not_found")
        ? 404
        : result.error === "no_open_business_day"
        ? 409
        : 409;
      return res.status(status).json(result);
    }
    if (result.approvalPending) return res.status(202).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/taskirat/offices — قائمة مكاتب التسكير.
 */
router.get("/taskirat/offices", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query(
        `select * from taskir_offices where branch_id = $1 order by created_at desc`,
        [req.auth.branchId]
      )
    );
    res.json({ offices: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/taskirat/offices — إضافة مكتب تسكير جديد.
 */
router.post("/taskirat/offices", async (req, res, next) => {
  const name = (req.body?.name || "").trim();
  const phone = req.body?.phone || null;
  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: existing } = await client.query(
        "select id from taskir_offices where branch_id = $1 and name = $2",
        [req.auth.branchId, name]
      );
      if (existing[0]) return { error: "name_taken" };

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from taskir_offices where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `OFC-${String(refRows[0].n).padStart(4, "0")}`;

      const { rows } = await client.query(
        `insert into taskir_offices (branch_id, ref, name, created_by)
         values ($1,$2,$3,$4) returning *`,
        [req.auth.branchId, ref, name, req.auth.userId]
      );
      // phone ليس عمودًا في الجدول (schema.sql: id/branch_id/ref/name/
      // created_at فقط) — يُرجَع في الاستجابة فقط إن أُرسل، ليُعرض في
      // الواجهة فورًا، دون أن يُخزَّن (فجوة معروفة، غير معالَجة في هذا
      // العمل: التخزين يتطلب عمود phone إضافي لم يُطلب صراحةً بعد).
      return { office: { ...rows[0], phone } };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/taskir-offices/:officeId/tx — دفتر حركات مكتب واحد
 * (TaskirOfficesPage.jsx).
 */
router.get("/taskir-offices/:officeId/tx", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query(
        `select * from taskir_office_tx
          where branch_id = $1 and office_id = $2
          order by created_at desc`,
        [req.auth.branchId, req.params.officeId]
      )
    );
    res.json({ officeTx: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * مكتب التسكير كالبنك (migration 080): ذهبٌ لنا محفوظٌ عنده بوزنه وتكلفته (1240) — لا مشتريات ولا مصروف.
 *   GET  /taskir-offices/:officeId/holdings            — رصيد المحفوظ بكل عيار ومتوسّط تكلفته
 *   POST /taskir-offices/:officeId/hold/buy            — شراء ذهبٍ وإيداعه عنده: نقدًا من الخزنة أو آجلًا (2130)
 *   POST /taskir-offices/:officeId/hold/withdraw       — سحبه إلى خزنتنا (1240 ← 1220) بقيمته الدفترية
 *   POST /taskir-offices/:officeId/hold/to-supplier    — سداد موردٍ منه (1240 ← دين المورد) بتكلفته
 */
async function officeHoldings(client, branchId, officeId) {
  const { rows } = await client.query(
    `select karat, coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as w,
            coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as cost
       from taskir_office_tx where branch_id = $1 and office_id = $2 and kind = 'hold' group by karat`, [branchId, officeId]);
  return rows.map((r) => ({ karat: Number(r.karat), weight: roundWeight(Number(r.w)), cost: roundMoney(Number(r.cost)),
    costPerGram: Number(r.w) > 0.0005 ? Number(r.cost) / Number(r.w) : 0 })).filter((r) => r.weight > 0.0005);
}

async function officeCtx(client, req) {
  const { rows } = await client.query("select id, name from taskir_offices where id = $1 and branch_id = $2", [req.params.officeId, req.auth.branchId]);
  if (!rows[0]) return { error: "office_not_found" };
  const { rows: dayRows } = await client.query(
    "select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
  return { office: rows[0], businessDayId: dayRows[0]?.id || null };
}

const holdStatus = (r) => (r.error ? (r.error.endsWith("_not_found") ? 404 : 409) : 201);

router.get("/taskir-offices/:officeId/holdings", async (req, res, next) => {
  try {
    const holdings = await withBranch(req.auth.branchId, (c) => officeHoldings(c, req.auth.branchId, req.params.officeId));
    res.json({ holdings });
  } catch (err) { next(err); }
});

router.post("/taskir-offices/:officeId/hold/buy", requireManager, async (req, res, next) => {
  const b = req.body || {};
  const karat = Number(b.karat), weight = roundWeight(Number(b.weight)), price = Number(b.pricePerGram);
  const source = ["safe_cash", "safe_network", "deferred"].includes(b.source) ? b.source : null;
  if (!KARATS.includes(karat) || !(weight > 0)) return res.status(400).json({ error: "invalid_karat_or_weight" });
  if (!(price > 0)) return res.status(400).json({ error: "invalid_price_per_gram" });
  if (!source) return res.status(400).json({ error: "invalid_source" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const ctx = await officeCtx(c, req);
      if (ctx.error) return ctx;
      const cost = roundMoney(weight * price), fine = fineWeight(weight, karat);
      const label = `ذهبٌ لنا عند مكتب ${ctx.office.name} — شراء ${weight} جم عيار ${karat}`;
      let credit = "2130";
      if (source !== "deferred") {
        const method = source === "safe_cash" ? "cash" : "network";
        const available = await poolBalance(c, req.auth.branchId, "safe", method);
        if (cost > available + 0.005) return { error: "insufficient_pool_balance", available, requested: cost };
        credit = method === "cash" ? "1110" : "1120";
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'safe',$3,'out',$4,'office_hold_buy','taskir_offices',$5,$6,$7)`,
          [req.auth.branchId, ctx.businessDayId, method, cost, ctx.office.id, label, req.auth.userId]);
      }
      const { rows: tx } = await c.query(
        `insert into taskir_office_tx (branch_id, office_id, business_day_id, direction, kind, amount, weight, karat, ref_table, note, created_by)
         values ($1,$2,$3,'in','hold',$4,$5,$6,'taskir_offices',$7,$8) returning id`,
        [req.auth.branchId, ctx.office.id, ctx.businessDayId, cost, weight, karat, label, req.auth.userId]);
      if (source === "deferred") {
        // الآجل دَينٌ للمكتب في دفتره بالوزن الصافي — مربوطٌ بسطر الإيداع، ويُسدَّد من «سداد المكتب» عامًّا أو بعينه
        await c.query(
          `insert into taskir_office_tx (branch_id, office_id, business_day_id, direction, kind, amount, weight, karat, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'in','gold',$4,$5,24,'taskir_office_tx',$6,$7,$8)`,
          [req.auth.branchId, ctx.office.id, ctx.businessDayId, cost, fine, tx[0].id, `${label} — آجل`, req.auth.userId]);
      }
      await c.query(
        `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'office_hold_buy',$3,$4,$5,null,'1240','taskir_office_tx',$6,$7,$8)`,
        [req.auth.branchId, ctx.businessDayId, karat, weight, fine, tx[0].id, label, req.auth.userId]);
      const journalEntryId = await postJournalEntry(c, {
        branchId: req.auth.branchId, businessDayId: ctx.businessDayId, opType: source === "deferred" ? "office_hold_buy_deferred" : "office_hold_buy",
        refTable: "taskir_office_tx", refId: tx[0].id, description: label, createdBy: req.auth.userId,
        lines: [{ account: "1240", side: "debit", amount: cost }, { account: credit, side: "credit", amount: cost }],
      });
      return { ok: true, txId: tx[0].id, cost, journalEntryId, holdings: await officeHoldings(c, req.auth.branchId, ctx.office.id) };
    });
    res.status(holdStatus(out)).json(out);
  } catch (err) { next(err); }
});

// يخرج من المحفوظ بمتوسّط تكلفته: سحبٌ إلى الخزنة أو سدادٌ لمورد
async function takeFromHolding(c, req, ctx, { karat, weight, note, supplierId = null }) {
  const hold = (await officeHoldings(c, req.auth.branchId, ctx.office.id)).find((h) => h.karat === karat);
  if (!hold || weight > hold.weight + 0.0005) return { error: "insufficient_holding", available: hold?.weight || 0, requested: weight };
  const cost = roundMoney(weight >= hold.weight - 0.0005 ? hold.cost : hold.costPerGram * weight);
  const { rows: tx } = await c.query(
    `insert into taskir_office_tx (branch_id, office_id, business_day_id, direction, kind, amount, weight, karat, ref_table, ref_id, note, created_by)
     values ($1,$2,$3,'out','hold',$4,$5,$6,$7,$8,$9,$10) returning id`,
    [req.auth.branchId, ctx.office.id, ctx.businessDayId, cost, weight, karat, supplierId ? "suppliers" : "taskir_offices", supplierId, note, req.auth.userId]);
  return { txId: tx[0].id, cost };
}

router.post("/taskir-offices/:officeId/hold/withdraw", requireManager, async (req, res, next) => {
  const karat = Number(req.body?.karat), weight = roundWeight(Number(req.body?.weight));
  if (!KARATS.includes(karat) || !(weight > 0)) return res.status(400).json({ error: "invalid_karat_or_weight" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const ctx = await officeCtx(c, req);
      if (ctx.error) return ctx;
      const label = `سحب ذهبنا من مكتب ${ctx.office.name} إلى الخزنة — ${weight} جم عيار ${karat}`;
      const t = await takeFromHolding(c, req, ctx, { karat, weight, note: label });
      if (t.error) return t;
      await c.query(
        `insert into safe_gold_tx (branch_id, business_day_id, direction, karat, weight, kind, office_id, note, created_by, ref_table, ref_id)
         values ($1,$2,'in',$3,$4,'raw',$5,$6,$7,'taskir_office_tx',$8)`,
        [req.auth.branchId, ctx.businessDayId, karat, weight, ctx.office.id, label, req.auth.userId, t.txId]);
      await c.query(
        `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'office_hold_withdraw',$3,$4,$5,'1240','1220','taskir_office_tx',$6,$7,$8)`,
        [req.auth.branchId, ctx.businessDayId, karat, weight, fineWeight(weight, karat), t.txId, label, req.auth.userId]);
      const journalEntryId = t.cost > 0 ? await postJournalEntry(c, {
        branchId: req.auth.branchId, businessDayId: ctx.businessDayId, opType: "office_hold_withdraw",
        refTable: "taskir_office_tx", refId: t.txId, description: label, createdBy: req.auth.userId,
        lines: [{ account: "1220", side: "debit", amount: t.cost }, { account: "1240", side: "credit", amount: t.cost }],
      }) : null;
      return { ok: true, cost: t.cost, journalEntryId, holdings: await officeHoldings(c, req.auth.branchId, ctx.office.id) };
    });
    res.status(holdStatus(out)).json(out);
  } catch (err) { next(err); }
});

router.post("/taskir-offices/:officeId/hold/to-supplier", requireManager, async (req, res, next) => {
  const karat = Number(req.body?.karat), weight = roundWeight(Number(req.body?.weight)), supplierId = req.body?.supplierId;
  if (!supplierId) return res.status(400).json({ error: "supplier_required" });
  if (!KARATS.includes(karat) || !(weight > 0)) return res.status(400).json({ error: "invalid_karat_or_weight" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const ctx = await officeCtx(c, req);
      if (ctx.error) return ctx;
      const { rows: sp } = await c.query("select id, name from suppliers where id = $1 and branch_id = $2", [supplierId, req.auth.branchId]);
      if (!sp[0]) return { error: "supplier_not_found" };
      const fine = fineWeight(weight, karat);
      const label = `سداد المورد ${sp[0].name} من ذهبنا عند مكتب ${ctx.office.name} — ${weight} جم عيار ${karat}`;
      const t = await takeFromHolding(c, req, ctx, { karat, weight, note: label, supplierId });
      if (t.error) return t;
      // دين المورد بالوزن ينخفض بالصافي المسلَّم، والذهب يخرج من 1240 بتكلفته
      await c.query(
        `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,'decrease',$4,0,'taskir_office_tx',$5,$6,$7)`,
        [req.auth.branchId, supplierId, ctx.businessDayId, fine, t.txId, label, req.auth.userId]);
      await c.query(
        `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'office_hold_to_supplier',$3,$4,$5,'1240',null,'taskir_office_tx',$6,$7,$8)`,
        [req.auth.branchId, ctx.businessDayId, karat, weight, fine, t.txId, label, req.auth.userId]);
      const journalEntryId = t.cost > 0 ? await postJournalEntry(c, {
        branchId: req.auth.branchId, businessDayId: ctx.businessDayId, opType: "office_hold_to_supplier",
        refTable: "taskir_office_tx", refId: t.txId, description: label, createdBy: req.auth.userId,
        lines: [{ account: "2110", side: "debit", amount: t.cost }, { account: "1240", side: "credit", amount: t.cost }],
      }) : null;
      return { ok: true, cost: t.cost, fine, journalEntryId, holdings: await officeHoldings(c, req.auth.branchId, ctx.office.id) };
    });
    res.status(holdStatus(out)).json(out);
  } catch (err) { next(err); }
});

/**
 * POST /api/taskir-offices/:officeId/settle — سداد مكتب تسكير
 * (handleSettleOffice في المرجع). مقيَّد بـrequireManager تمامًا كما في
 * TaskirOfficesPage.jsx (canManage={role === "manager"}).
 *
 * وضع gold: يخرج ذهب من الخزنة (safe_gold_tx) للمكتب مباشرة — لا نقد.
 * وضع cash: يُسدَّد مبلغ نقدي من الخزنة، محسوبًا بسعر اليوم كمعادل ذهب
 * دقيق (fine) يُسجَّل رغم أنه سداد نقدي، حفاظًا على دقة دفتر المكتب.
 */
router.post("/taskir-offices/:officeId/settle", requireManager, async (req, res, next) => {
  const officeId = req.params.officeId;
  const body = req.body || {};
  const mode = body.mode;

  if (mode !== "gold" && mode !== "cash") {
    return res.status(400).json({ error: "invalid_mode" });
  }
  let karat = null;
  let weight = 0;
  let amount = 0;
  let source = null;
  if (mode === "gold") {
    karat = Number(body.karat);
    weight = Number(body.weight);
    if (!KARATS.includes(karat) || !(weight > 0)) {
      return res.status(400).json({ error: "invalid_karat_or_weight" });
    }
  } else {
    amount = roundMoney(body.amount || 0);
    source = body.source;
    if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
    const poolMethod = fundingToPoolMethod(source) || (source === "safe_cash" ? { pool: "safe", method: "cash" } : source === "safe_network" ? { pool: "safe", method: "network" } : null);
    if (!poolMethod) return res.status(400).json({ error: "invalid_source" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: officeRows } = await client.query(
        "select id, name from taskir_offices where id = $1 and branch_id = $2",
        [officeId, req.auth.branchId]
      );
      if (!officeRows[0]) return { error: "office_not_found" };
      const office = officeRows[0];

      const { rows: dayRows } = await client.query(
        `select id from business_days where branch_id = $1 and status = 'open'
          order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDayId = dayRows[0]?.id || null;
      const label = `سداد مكتب ${office.name}`;

      if (mode === "gold") {
        const fine = fineWeight(weight, karat);
        await client.query(
          `insert into taskir_office_tx
             (branch_id, office_id, business_day_id, direction, kind, weight, karat,
              ref_table, note, created_by)
           values ($1,$2,$3,'out','gold',$4,$5,'taskir_offices',$6,$7)`,
          [req.auth.branchId, officeId, businessDayId, fine, 24, label, req.auth.userId]
        );
        await client.query(
          `insert into safe_gold_tx
             (branch_id, business_day_id, direction, karat, weight, destination, office_id, note, created_by)
           values ($1,$2,'out',$3,$4,'taskir_office',$5,$6,$7)`,
          [req.auth.branchId, businessDayId, karat, weight, officeId, label, req.auth.userId]
        );
        // ⚠ posting_rules.settle_office_gold صريحة في seed.sql: cash:
        // null. لا قيد يومية مالي هنا عمدًا — الالتزام مُقوَّم أصلًا
        // بجنيهات وقت إنشائه (posting settle_office عند POST /taskirat)،
        // وأي تقييم جديد هنا بسعر اليوم لن يوازن دفتريًا مع تلك القيمة
        // الأصلية. سطرا taskir_office_tx (أعلاه) وsafe_gold_tx يكفيان
        // لتوثيق الحركة الفعلية: خروج وزن من الخزنة، دون افتراض قيمة
        // نقدية مصطنعة لالتزام مقوَّم أصلًا بغير ذلك.
        return { settled: { mode, karat, weight, fine } };
      } else {
        const poolMethod = fundingToPoolMethod(source) || (source === "safe_cash" ? { pool: "safe", method: "cash" } : { pool: "safe", method: "network" });
        const priceAtSettle = Number(body.priceAtSettle) || 0;
        let fine = priceAtSettle > 0 ? roundWeight(amount / priceAtSettle) : 0;
        // سدادُ شراءٍ آجلٍ بعينه: يُطفئ من وزنه بنسبة المبلغ إلى ثمنه — لا بسعر اليوم
        let forTx = null;
        if (body.forTxId) {
          const { rows: ft } = await client.query(
            `select id, amount, weight from taskir_office_tx where id = $1 and branch_id = $2 and office_id = $3 and direction = 'in' and kind = 'gold' and amount > 0`,
            [body.forTxId, req.auth.branchId, officeId]);
          forTx = ft[0];
          if (!forTx) return { error: "deferred_tx_not_found" };
          const { rows: paid } = await client.query(
            `select coalesce(sum(amount), 0) as a from taskir_office_tx where branch_id = $1 and ref_table = 'taskir_office_tx' and ref_id = $2 and direction = 'out'`,
            [req.auth.branchId, forTx.id]);
          const left = roundMoney(Number(forTx.amount) - Number(paid[0].a));
          if (amount > left + 0.005) return { error: "amount_exceeds_deferred", left };
          fine = roundWeight(Number(forTx.weight) * amount / Number(forTx.amount));
        }
        if (!(fine > 0)) return { error: "price_required" };
        // ⚠ سداد المكتب لا يُنزل صندوقه تحت الصفر (المرجع 5.2.0)
        const available = await poolBalance(client, req.auth.branchId, poolMethod.pool, poolMethod.method);
        if (amount > available + 0.005) return { error: "insufficient_pool_balance", available, requested: amount };
        await client.query(
          `insert into taskir_office_tx
             (branch_id, office_id, business_day_id, direction, kind, amount, weight, karat,
              ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'out','cash',$4,$5,24,$6,$7,$8,$9)`,
          [req.auth.branchId, officeId, businessDayId, amount, fine, forTx ? "taskir_office_tx" : "taskir_offices", forTx?.id || null, label, req.auth.userId]
        );
        // الحساب النقدي بحسب الوعاء: الخزنة 1110/1120 · الصندوق اليومي 1130/1140
        const creditAccount = poolMethod.pool === "daily"
          ? (poolMethod.method === "cash" ? "1130" : "1140")
          : (poolMethod.method === "cash" ? "1110" : "1120");
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,'out',$5,'office_settle','taskir_offices',$6,$7,$8)`,
          [req.auth.branchId, businessDayId, poolMethod.pool, poolMethod.method, amount, officeId, label, req.auth.userId]
        );
        const journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "settle_office_cash",
          refTable: "taskir_offices",
          refId: officeId,
          description: label,
          createdBy: req.auth.userId,
          lines: [
            { account: "2130", side: "debit", amount },
            { account: creditAccount, side: "credit", amount },
          ],
        });
        return { settled: { mode, amount, fine }, journalEntryId };
      }
    });

    if (result.error) {
      const status = result.error.endsWith("_not_found") ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
