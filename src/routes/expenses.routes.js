import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";

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
  const category = CATEGORY_ACCOUNTS[body.category] ? body.category : null;
  const fundingSource = CASH_ACCOUNTS[body.fundingSource] ? body.fundingSource : null;
  const name = (body.name || "").trim();
  const isPayroll = category === "salaries" || category === "advance";

  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
  if (!category) return res.status(400).json({ error: "invalid_category" });
  if (!fundingSource) return res.status(400).json({ error: "invalid_funding_source" });
  if (!name) return res.status(400).json({ error: "name_required" });
  if (isPayroll && !body.employeeId) return res.status(400).json({ error: "employee_required" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
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

      const { rows: expRows } = await client.query(
        `insert into expenses
           (branch_id, ref, name, name_id, amount, business_day_id, category, note, recurring,
            funding_source, employee_id, period_month, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         returning *`,
        [
          req.auth.branchId, ref, name, nameId, amount, businessDayId, category,
          body.note || null, !!body.recurring, fundingSource, isPayroll ? body.employeeId : null,
          isPayroll ? body.periodMonth || null : null, req.auth.userId,
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

      const debitAccount = CATEGORY_ACCOUNTS[category];
      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: "expense",
        refTable: "expenses",
        refId: expense.id,
        description: `${name} — ${ref}`,
        createdBy: req.auth.userId,
        lines: [
          { account: debitAccount, side: "debit", amount },
          { account: cashAccount, side: "credit", amount },
        ],
      });

      return { expense, cashTx: cashTxRows[0], journalEntryId };
    });

    if (result.error === "employee_not_found") {
      return res.status(404).json({ error: "employee_not_found" });
    }
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
