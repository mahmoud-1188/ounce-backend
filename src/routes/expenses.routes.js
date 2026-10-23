import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied, requireManager } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";
import { approvalGate } from "../domain/approvals.js";

const router = Router();

/**
 * المصروفات كانت محفوظة محليًا فقط رغم أن /day/close (migration 008)
 * يقرأ فعليًا sum(amount) from expenses لحساب expenses_sum عند الإقفال —
 * فكان الرقم صفرًا زائفًا دائمًا. هذا الملف يضيف الكتابة الحقيقية،
 * ويطابق تمامًا حسابات chart.js's EXPENSE_CATEGORY_ACCOUNTS (راجع
 * migration 010 للأعمدة الإضافية التي يحتاجها هذا الشكل).
 *
 * ⚠ نطاق متعمَّد: هذا لا يبني دفتر رواتب/سلف موظفين كامل (لا جدول
 * payroll في الباك إند إطلاقًا بعد) — employeeId هنا مجرد إسناد وصفي على
 * سجل المصروف نفسه، تمامًا كحد أقصى لما تحتاجه لقطة إغلاق اليوم ودفتر
 * اليومية. ربط ذلك بكشف راتب فعلي (خصم السلفة من مستحقاته لاحقًا) يبقى
 * فجوة منفصلة أكبر، غير مطلوبة لإصلاح رقم الإقفال.
 */
// requireNotDenied("expense") مطابق تمامًا لفحص can("expense") في الواجهة
// (raها ROLES[role].denyActions يشمل "expense" لأدوار مثل scrap_buyer/
// scrap_officer) — لا دور حاليًا يجمع بين صلاحية صفحة "expenses" ومنع
// "expense" معًا، لكن requirePage وحده لا يكفي لو أُضيف دور كذلك لاحقًا.
router.use("/expenses", authenticate, requirePage("expenses"), requireNotDenied("expense"));
router.use("/expense-names", authenticate, requirePage("expenses"), requireNotDenied("expense"));
router.use("/fixed-expenses", authenticate, requirePage("expenses"), requireNotDenied("expense"));
router.use("/expense-accounts", authenticate, requirePage("expenses"));

// ══ قوالب المصروفات الثابتة (migration 074) ══
const fixedOf = (r) => ({ id: r.id, name: r.name, category: r.category, amount: Number(r.amount), day: r.day, fundingSource: r.funding_source,
  note: r.note || "", active: !!r.active, lastPosted: r.last_posted || null, lastExpenseId: r.last_expense_id || null });
const normName = (v) => String(v || "").replace(/[أإآ]/g, "ا").replace(/\s+/g, "").trim();
function fixedRefusal(b) {
  if (!String(b.name || "").trim()) return "name_required";
  if (!(roundMoney(b.amount) > 0)) return "invalid_amount";
  const day = Math.round(Number(b.day));
  if (!(day >= 1 && day <= 28)) return "invalid_day";
  if ((!CATEGORY_ACCOUNTS[b.category] && !CUSTOM_CATEGORY.test(b.category || "")) || ["salaries", "advance"].includes(b.category)) return "invalid_category";
  if (!CASH_ACCOUNTS[b.fundingSource]) return "invalid_funding_source";
  return null;
}
router.get("/fixed-expenses", async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query("select * from fixed_expenses where branch_id = $1 order by day, name", [req.auth.branchId])).rows);
    res.json({ fixed: rows.map(fixedOf) });
  } catch (err) { next(err); }
});
router.post("/fixed-expenses", async (req, res, next) => {
  const b = req.body || {};
  const why = fixedRefusal(b);
  if (why) return res.status(400).json({ error: why });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: ex } = await c.query("select name from fixed_expenses where branch_id = $1", [req.auth.branchId]);
      if (ex.some((r) => normName(r.name) === normName(b.name))) return { error: "duplicate_name" };
      const { rows } = await c.query(
        `insert into fixed_expenses (branch_id, name, category, amount, day, funding_source, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.auth.branchId, String(b.name).trim().slice(0, 60), b.category, roundMoney(b.amount), Math.round(Number(b.day)), b.fundingSource, String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      return { fixed: fixedOf(rows[0]) };
    });
    if (out.error) return res.status(409).json(out);
    res.status(201).json(out);
  } catch (err) { next(err); }
});
router.patch("/fixed-expenses/:id", async (req, res, next) => {
  const b = req.body || {};
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: cur } = await c.query("select * from fixed_expenses where id = $1 and branch_id = $2", [req.params.id, req.auth.branchId]);
      if (!cur[0]) return { error: "not_found" };
      const merged = { name: b.name ?? cur[0].name, amount: b.amount ?? cur[0].amount, day: b.day ?? cur[0].day, category: b.category ?? cur[0].category,
        fundingSource: b.fundingSource ?? cur[0].funding_source };
      const why = fixedRefusal(merged);
      if (why) return { error: why };
      const { rows } = await c.query(
        `update fixed_expenses set name = $3, amount = $4, day = $5, category = $6, funding_source = $7, note = $8, active = $9
          where id = $1 and branch_id = $2 returning *`,
        [req.params.id, req.auth.branchId, String(merged.name).trim().slice(0, 60), roundMoney(merged.amount), Math.round(Number(merged.day)), merged.category,
          merged.fundingSource, b.note !== undefined ? String(b.note || "").slice(0, 200) || null : cur[0].note, b.active != null ? !!b.active : cur[0].active]);
      return { fixed: fixedOf(rows[0]) };
    });
    if (out.error) return res.status(out.error === "not_found" ? 404 : 400).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

// ⚠ يطابق EXPENSE_CATEGORIES في core/constants.js وحساباتها في
// core/chart.js سطرًا بسطر — أي تصنيف جديد هناك يحتاج سطرًا هنا أيضًا.
const CATEGORY_ACCOUNTS = {
  rent: "6100",
  bills: "6300",
  government: "6400",
  salaries: "6710",
  // ⚠ السلفة أصل (ذمم موظفين) لا مصروف — تُخصم من 2350 حين السداد لاحقًا،
  // لا تُحمَّل على قائمة الدخل. نفس ملاحظة chart.js حرفيًا.
  advance: "2350",
  purchases: "6900",
  other: "6900",
};

// حسابٌ مخصّص للمتجر: الفئة «acc_<رمزه>» (migration 096)
const CUSTOM_CATEGORY = /^acc_69\d{5}$/;

/** حساب المدين لفئة المصروف: القياسية من الجدول أعلاه، والمخصّصة من حسابات متجر الفرع الظاهرة وحدها. */
async function expenseAccountOf(client, branchId, category) {
  if (CATEGORY_ACCOUNTS[category]) return CATEGORY_ACCOUNTS[category];
  if (!CUSTOM_CATEGORY.test(category || "")) return null;
  const { rows } = await client.query(
    `select a.code from accounts a join branches b on b.store_id = a.store_id
      where a.code = $1 and b.id = $2 and not a.hidden`, [category.slice(4), branchId]);
  return rows[0]?.code || null;
}

const accountOf = (r) => ({ code: r.code, name: r.name, hidden: !!r.hidden, category: `acc_${r.code}`, createdAt: r.created_at });

// ── حسابات المصروف المخصّصة: الكلّ يقرأ، والإضافة والإخفاء للمدير (فعل chartEdit — تمنعه الإدارة من سياستها) ──
router.get("/expense-accounts", async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select a.* from accounts a join branches b on b.store_id = a.store_id where b.id = $1 order by a.created_at, a.code`,
      [req.auth.branchId])).rows);
    res.json({ accounts: rows.map(accountOf) });
  } catch (err) { next(err); }
});

router.post("/expense-accounts", requireManager, requireNotDenied("chartEdit"), async (req, res, next) => {
  const name = String(req.body?.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: "name_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: st } = await c.query("select store_id from branches where id = $1", [req.auth.branchId]);
      const storeId = st[0]?.store_id;
      if (!storeId) return { error: "no_store" };
      const { rows: dup } = await c.query(
        "select code from accounts where name = $1 and (store_id is null or store_id = $2) limit 1", [name, storeId]);
      if (dup[0]) return { error: "name_taken", code: dup[0].code };
      const { rows: seq } = await c.query("select nextval('custom_expense_account_seq')::int as n");
      if (seq[0].n > 99999) return { error: "no_code_left" };
      const code = `69${String(seq[0].n).padStart(5, "0")}`;
      const { rows } = await c.query(
        `insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method, store_id)
         values ($1, $2, '6000', 'currency', 'debit', 'income', false, null, null, $3) returning *`, [code, name, storeId]);
      return { account: accountOf(rows[0]) };
    });
    if (out.error) return res.status(out.error === "name_taken" ? 409 : 400).json(out);
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// إخفاءٌ لا حذف: الحساب عليه قيود؛ يُخفى من اختيار المصروف ويبقى في الدفاتر باسمه
router.patch("/expense-accounts/:code", requireManager, requireNotDenied("chartEdit"), async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update accounts a set hidden = $3 from branches b
          where a.code = $1 and b.id = $2 and a.store_id = b.store_id returning a.*`,
        [req.params.code, req.auth.branchId, !!req.body?.hidden]);
      return rows[0] ? { account: accountOf(rows[0]) } : { error: "not_found" };
    });
    if (out.error) return res.status(404).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

// pool×method → حساب النقد المتأثر، مطابق تمامًا لسطور seed.sql
// (1110 خزنة/نقدي، 1120 خزنة/شبكة، 1130 يومي/نقدي، 1140 يومي/شبكة).
const CASH_ACCOUNTS = {
  safe_cash: { pool: "safe", method: "cash", account: "1110" },
  safe_network: { pool: "safe", method: "network", account: "1120" },
  daily_cash: { pool: "daily", method: "cash", account: "1130" },
  daily_network: { pool: "daily", method: "network", account: "1140" },
};

router.get("/expenses", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select * from expenses where branch_id = $1 order by created_at desc limit 500`,
        [req.auth.branchId]
      );
      return { expenses: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/expenses", async (req, res, next) => {
  const body = req.body || {};
  const amount = roundMoney(body.amount);
  const category = CATEGORY_ACCOUNTS[body.category] || CUSTOM_CATEGORY.test(body.category || "") ? body.category : null;
  const fundingSource = CASH_ACCOUNTS[body.fundingSource] ? body.fundingSource : null;
  const name = (body.name || "").trim();
  const isPayroll = category === "salaries" || category === "advance";

  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
  if (!category) return res.status(400).json({ error: "invalid_category" });
  if (!fundingSource) return res.status(400).json({ error: "invalid_funding_source" });
  if (!name) return res.status(400).json({ error: "name_required" });
  if (isPayroll && !body.employeeId) return res.status(400).json({ error: "employee_required" });
  // ضريبة المدخلات داخل المبلغ (migration 089): تُطرح من المصروف وتُقيَّد على 1360 — لا للرواتب والسلف
  const vatAmount = isPayroll ? 0 : roundMoney(body.vatAmount || 0);
  if (vatAmount < 0 || vatAmount >= amount) return res.status(400).json({ error: "invalid_vat_amount" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      // الحساب المخصّص يُتحقَّق منه قبل الاعتماد: لمتجر هذا الفرع، وغير مخفيّ
      const debitAccount = await expenseAccountOf(client, req.auth.branchId, category);
      if (!debitAccount) return { error: "invalid_category" };

      // ⚖ ما فوق حدّ الاعتماد لا يُنفَّذ بل يُحفظ طلبًا بحمولته
      const gate = await approvalGate(client, req.auth, {
        kind: "expense", amount, approvalId: body.approvalId || null, note: name, category,
        payload: { ...body, approvalId: undefined },
      });
      if (gate.error) return gate;
      if (gate.pending) return { approvalPending: gate.pending };

      const businessDayId = await openDay(client, req.auth.branchId);

      if (isPayroll) {
        const { rows: empRows } = await client.query(
          `select id from users where id = $1 and branch_id = $2`,
          [body.employeeId, req.auth.branchId]
        );
        if (!empRows[0]) return { error: "employee_not_found" };
      }

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from expenses where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `EXP-${String(refRows[0].n).padStart(6, "0")}`;

      let nameId = null;
      if (body.nameId) {
        const { rows: nameRows } = await client.query(
          `select id from expense_names where id = $1 and branch_id = $2`,
          [body.nameId, req.auth.branchId]
        );
        nameId = nameRows[0]?.id || null;
      }

      // مركز التكلفة (migration 100): اختياريّ، ومن مراكز هذا الفرع القائمة وحدها
      let costCenterId = null;
      if (body.costCenterId) {
        const { rows: cc } = await client.query(
          "select id from cost_centers where id = $1 and branch_id = $2 and active", [body.costCenterId, req.auth.branchId]);
        if (!cc[0]) return { error: "invalid_cost_center" };
        costCenterId = cc[0].id;
      }

      const { rows: expRows } = await client.query(
        `insert into expenses
           (branch_id, ref, name, name_id, amount, business_day_id, category, note, recurring,
            funding_source, employee_id, period_month, created_by, installments, attach_id, vat_amount, cost_center_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         returning *`,
        [
          req.auth.branchId, ref, name, nameId, amount, businessDayId, category,
          body.note || null, !!body.recurring, fundingSource, isPayroll ? body.employeeId : null,
          isPayroll ? body.periodMonth || null : null, req.auth.userId,
          category === "advance" ? Math.min(60, Math.max(1, Math.round(Number(body.installments) || 1))) : 1,
          typeof body.attachId === "string" && body.attachId.length <= 80 ? body.attachId : null,
          vatAmount, costCenterId,
        ]
      );
      const expense = expRows[0];

      const { pool, method, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
      const { rows: cashTxRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,'out',$5,'expense',$6,$7,$8,$9)
         returning *`,
        [req.auth.branchId, businessDayId, pool, method, amount, "expenses", expense.id, `مصروف - ${name}`, req.auth.userId]
      );

      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: "expense",
        refTable: "expenses",
        refId: expense.id,
        description: `${name} — ${ref}`,
        createdBy: req.auth.userId,
        lines: [
          { account: debitAccount, side: "debit", amount: roundMoney(amount - vatAmount) },
          { account: "1360", side: "debit", amount: vatAmount },
          { account: cashAccount, side: "credit", amount },
        ],
      });

      // مصروفٌ من قالبٍ ثابت: يُعلَّم شهره مسجَّلًا بعد نجاح القيد وحده (المعلّق للاعتماد لا يُعلَّم حتى يُنفَّذ)
      if (body.fixedId) {
        await client.query(
          `update fixed_expenses set last_posted = to_char(now(), 'YYYY-MM'), last_expense_id = $3 where id = $1 and branch_id = $2`,
          [body.fixedId, req.auth.branchId, expense.id]);
      }
      return { expense, cashTx: cashTxRows[0], journalEntryId };
    });

    if (result.error === "employee_not_found") {
      return res.status(404).json({ error: "employee_not_found" });
    }
    if (result.error) return res.status(409).json(result);
    if (result.approvalPending) return res.status(202).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/expense-names", async (req, res, next) => {
  const body = req.body || {};
  const name = (body.name || "").trim();
  const category = body.category || "other";
  if (!name) return res.status(400).json({ error: "name_required" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: existing } = await client.query(
        `select id from expense_names where branch_id = $1 and lower(name) = lower($2)`,
        [req.auth.branchId, name]
      );
      if (existing[0]) return { error: "name_taken" };

      const { rows } = await client.query(
        `insert into expense_names (branch_id, name, category) values ($1,$2,$3) returning *`,
        [req.auth.branchId, name, category]
      );
      return { expenseName: rows[0] };
    });

    if (result.error === "name_taken") return res.status(409).json({ error: "name_taken" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/expense-names/:id", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rowCount } = await client.query(
        `delete from expense_names where id = $1 and branch_id = $2`,
        [req.params.id, req.auth.branchId]
      );
      return { deleted: rowCount > 0 };
    });
    if (!result.deleted) return res.status(404).json({ error: "not_found" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
