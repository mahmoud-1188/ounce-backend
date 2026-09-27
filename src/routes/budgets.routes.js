import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager, requirePage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";

const router = Router();

/**
 * الموازنات وإقرار الضريبة (migration 060):
 *   GET  /budgets?period=YYYY-MM          — المخطَّط لكل حساب مصروف/إيراد مقابل الفعلي من دفتر اليومية
 *   PUT  /budgets { period, lines:[{account, amount}] }   (0 يحذف السطر)
 *   POST /budgets/copy { from, to }       — ينسخ موازنة شهرٍ لشهرٍ (لا يدوس ما كُتب)
 *   GET  /vat-return?from=YYYY-MM-DD&to=YYYY-MM-DD  — إقرار ضريبة القيمة المضافة من الفواتير والقيود
 * ⚠ الفعلي يُحسب من journal_lines بتاريخ الرياض — لا من شاشة المصروفات — فيشمل كل قيدٍ على الحساب.
 */
const PERIOD = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TZ = "Asia/Riyadh";

async function budgetRows(c, branchId, period) {
  const { rows: accs } = await c.query(
    `select code, name, nature from accounts
      where statement = 'income' and not coalesce(is_group, false) order by code`);
  const { rows: plan } = await c.query(
    "select account_code, amount from account_budgets where branch_id = $1 and period = $2", [branchId, period]);
  const { rows: act } = await c.query(
    `select l.account_code, sum(case when l.side = 'debit' then l.amount else -l.amount end)::numeric as net
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and to_char(e.created_at at time zone '${TZ}', 'YYYY-MM') = $2
      group by l.account_code`, [branchId, period]);
  const planBy = Object.fromEntries(plan.map((p) => [p.account_code, Number(p.amount)]));
  const actBy = Object.fromEntries(act.map((a) => [a.account_code, Number(a.net)]));
  const rows = accs.map((a) => {
    // الإيراد دائن بطبيعته: فعليّه موجبٌ حين يُقيَّد دائنًا
    const actual = roundMoney(a.nature === "debit" ? actBy[a.code] || 0 : -(actBy[a.code] || 0));
    const planned = planBy[a.code] ?? null;
    const over = planned == null ? false : a.nature === "debit" ? actual > planned + 0.005 : actual < planned - 0.005;
    return {
      account: a.code, name: a.name, nature: a.nature, planned, actual,
      variance: planned == null ? null : roundMoney(actual - planned),
      pct: planned > 0 ? Math.round((actual / planned) * 100) : null, over,
    };
  });
  const planned = rows.filter((r) => r.planned != null);
  const exp = planned.filter((r) => r.nature === "debit");
  return {
    period, rows,
    totals: {
      plannedExpense: roundMoney(exp.reduce((s, r) => s + r.planned, 0)),
      actualExpense: roundMoney(exp.reduce((s, r) => s + r.actual, 0)),
      overCount: planned.filter((r) => r.over).length,
    },
  };
}

router.get("/budgets", authenticate, requirePage("budgets"), async (req, res, next) => {
  const period = PERIOD.test(String(req.query.period || "")) ? String(req.query.period) : new Date().toISOString().slice(0, 7);
  try {
    res.json(await withBranch(req.auth.branchId, (c) => budgetRows(c, req.auth.branchId, period)));
  } catch (err) {
    next(err);
  }
});

router.put("/budgets", authenticate, requirePage("budgets"), requireManager, async (req, res, next) => {
  const b = req.body || {};
  if (!PERIOD.test(String(b.period || ""))) return res.status(400).json({ error: "invalid_period" });
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ account: String(l.account || ""), amount: roundMoney(Number(l.amount) || 0) }));
  if (!lines.length || lines.some((l) => !l.account || l.amount < 0)) return res.status(400).json({ error: "invalid_line" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: ok } = await c.query(
        "select code from accounts where code = any($1) and statement = 'income' and not coalesce(is_group, false)", [lines.map((l) => l.account)]);
      const okSet = new Set(ok.map((r) => r.code));
      if (lines.some((l) => !okSet.has(l.account))) return { error: "invalid_account" };
      for (const l of lines) {
        if (l.amount === 0) {
          await c.query("delete from account_budgets where branch_id = $1 and period = $2 and account_code = $3", [req.auth.branchId, b.period, l.account]);
        } else {
          await c.query(
            `insert into account_budgets (branch_id, period, account_code, amount, updated_by) values ($1,$2,$3,$4,$5)
             on conflict (branch_id, period, account_code) do update set amount = excluded.amount, updated_by = excluded.updated_by, updated_at = now()`,
            [req.auth.branchId, b.period, l.account, l.amount, req.auth.userId]);
        }
      }
      return budgetRows(c, req.auth.branchId, b.period);
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.post("/budgets/copy", authenticate, requirePage("budgets"), requireManager, async (req, res, next) => {
  const { from, to } = req.body || {};
  if (!PERIOD.test(String(from || "")) || !PERIOD.test(String(to || "")) || from === to) return res.status(400).json({ error: "invalid_period" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rowCount } = await c.query(
        `insert into account_budgets (branch_id, period, account_code, amount, updated_by)
         select branch_id, $3, account_code, amount, $4 from account_budgets where branch_id = $1 and period = $2
         on conflict (branch_id, period, account_code) do nothing`, [req.auth.branchId, from, to, req.auth.userId]);
      return { copied: rowCount, ...(await budgetRows(c, req.auth.branchId, to)) };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

function quarterRange(d = new Date()) {
  const q = Math.floor(d.getUTCMonth() / 3);
  const from = new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0));
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

router.get("/vat-return", authenticate, requirePage("vatReturn"), async (req, res, next) => {
  let [from, to] = quarterRange();
  if (DAY.test(String(req.query.from || ""))) from = String(req.query.from);
  if (DAY.test(String(req.query.to || ""))) to = String(req.query.to);
  if (from > to) return res.status(400).json({ error: "invalid_range" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: [s] } = await c.query(
        `select coalesce(sum(net_amount) filter (where tax_applicable), 0)::numeric as std_base,
                coalesce(sum(tax_amount) filter (where tax_applicable), 0)::numeric as std_vat,
                coalesce(sum(net_amount) filter (where not tax_applicable), 0)::numeric as exempt_base,
                count(*) filter (where tax_applicable)::int as std_count,
                count(*) filter (where not tax_applicable)::int as exempt_count
           from sales where branch_id = $1 and (date at time zone '${TZ}')::date between $2 and $3`,
        [req.auth.branchId, from, to]);
      // المردودات: قيد sale_return يحمل مدين 2220 بالضريبة ومدين 4190 بالصافي
      const { rows: [r] } = await c.query(
        `select coalesce(sum(l.amount) filter (where l.account_code = '2220' and l.side = 'debit'), 0)::numeric as vat,
                coalesce(sum(l.amount) filter (where l.account_code = '4190' and l.side = 'debit'), 0)::numeric as base,
                count(distinct e.id)::int as n
           from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.branch_id = $1 and e.op_type = 'sale_return' and (e.created_at at time zone '${TZ}')::date between $2 and $3`,
        [req.auth.branchId, from, to]);
      const { rows: [g] } = await c.query(
        `select coalesce(sum(case when l.side = 'credit' then l.amount else -l.amount end), 0)::numeric as net
           from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.branch_id = $1 and l.account_code = '2220' and (e.created_at at time zone '${TZ}')::date between $2 and $3`,
        [req.auth.branchId, from, to]);
      const outputVat = roundMoney(Number(s.std_vat));
      const adjVat = roundMoney(Number(r.vat));
      const netDue = roundMoney(outputVat - adjVat);
      const ledgerNet = roundMoney(Number(g.net));
      return {
        from, to,
        sales: {
          standard: { base: roundMoney(Number(s.std_base)), vat: outputVat, count: s.std_count },
          returns: { base: roundMoney(Number(r.base)), vat: adjVat, count: r.n },
          exempt: { base: roundMoney(Number(s.exempt_base)), count: s.exempt_count },
        },
        // ⚠ ضريبة المدخلات لا تُسجَّل في النظام بعد (لا حساب ضريبة مدخلات) — تُضاف يدويًّا عند الإقرار
        purchases: { vat: 0, tracked: false },
        netDue, ledgerNet, diff: roundMoney(ledgerNet - netDue),
      };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
