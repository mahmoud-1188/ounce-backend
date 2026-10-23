import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager, requirePage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

/**
 * الموازنات وإقرار الضريبة (migration 060):
 *   GET  /budgets?period=YYYY-MM          — المخطَّط لكل حساب مصروف/إيراد مقابل الفعلي من دفتر اليومية
 *   PUT  /budgets { period, lines:[{account, amount}] }   (0 يحذف السطر)
 *   POST /budgets/copy { from, to }       — ينسخ موازنة شهرٍ لشهرٍ (لا يدوس ما كُتب)
 *   GET  /vat-return?from=YYYY-MM-DD&to=YYYY-MM-DD  — إقرار ضريبة القيمة المضافة من الفواتير والقيود
 *   GET  /cost-centers?period=YYYY-MM     — مراكز التكلفة (migration 100) ومصروف كلٍّ منها في الشهر
 *   POST /cost-centers { name }            — مركزٌ جديد (للمدير)
 *   PATCH /cost-centers/:id { name?, active? } — إعادة تسمية أو إيقاف (لا يُحذف: مصروفاته تبقى منسوبةً إليه)
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
  const byCenter = await centerRows(c, branchId, period);
  const planned = rows.filter((r) => r.planned != null);
  const exp = planned.filter((r) => r.nature === "debit");
  return {
    period, rows, byCenter,
    totals: {
      plannedExpense: roundMoney(exp.reduce((s, r) => s + r.planned, 0)),
      actualExpense: roundMoney(exp.reduce((s, r) => s + r.actual, 0)),
      overCount: planned.filter((r) => r.over).length,
    },
  };
}

/// مصروف كل مركز تكلفةٍ في الشهر — من المصروفات المنسوبة إليه بتاريخ الرياض
async function centerRows(c, branchId, period) {
  const { rows } = await c.query(
    `select cc.id, cc.name, cc.active,
            coalesce(sum(e.amount) filter (where to_char(e.created_at at time zone '${TZ}', 'YYYY-MM') = $2), 0)::numeric as amount,
            count(e.id) filter (where to_char(e.created_at at time zone '${TZ}', 'YYYY-MM') = $2)::int as count
       from cost_centers cc left join expenses e on e.cost_center_id = cc.id and e.branch_id = cc.branch_id
      where cc.branch_id = $1
      group by cc.id order by cc.active desc, cc.name`, [branchId, period]);
  return rows.map((r) => ({ id: r.id, name: r.name, active: r.active, amount: roundMoney(Number(r.amount)), count: r.count }));
}

router.get("/cost-centers", authenticate, async (req, res, next) => {
  const period = PERIOD.test(String(req.query.period || "")) ? String(req.query.period) : new Date().toISOString().slice(0, 7);
  try {
    res.json({ period, centers: await withBranch(req.auth.branchId, (c) => centerRows(c, req.auth.branchId, period)) });
  } catch (err) {
    next(err);
  }
});

router.post("/cost-centers", authenticate, requireManager, async (req, res, next) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  if (name.length < 2) return res.status(400).json({ error: "name_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: dup } = await c.query(
        "select id from cost_centers where branch_id = $1 and lower(name) = lower($2)", [req.auth.branchId, name]);
      if (dup[0]) return { error: "cost_center_exists" };
      const { rows } = await c.query(
        "insert into cost_centers (branch_id, name) values ($1, $2) returning id, name, active", [req.auth.branchId, name]);
      return { center: rows[0] };
    });
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.patch("/cost-centers/:id", authenticate, requireManager, async (req, res, next) => {
  const b = req.body || {};
  const name = b.name != null ? String(b.name).trim().slice(0, 60) : null;
  if (name != null && name.length < 2) return res.status(400).json({ error: "name_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update cost_centers set name = coalesce($3, name), active = coalesce($4, active)
          where id = $1 and branch_id = $2 returning id, name, active`,
        [req.params.id, req.auth.branchId, name, typeof b.active === "boolean" ? b.active : null]);
      return rows[0] ? { center: rows[0] } : { error: "not_found" };
    });
    if (out.error) return res.status(404).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

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
          where e.branch_id = $1 and l.account_code = '2220' and (e.created_at at time zone '${TZ}')::date between $2 and $3
            and e.op_type not in ('vat_settlement', 'vat_settlement_reversal', 'vat_to_hq', 'group_vat_settlement')`,
        [req.auth.branchId, from, to]);
      // تسويةٌ قائمة تغطّي الفترة أو تتقاطع معها — تُعرض ويُمنع تكرارها
      const { rows: st } = await c.query(
        `select id, period_from::text as period_from, period_to::text as period_to, output_vat, input_vat, paid, source, created_at
           from vat_settlements where branch_id = $1 and reversed_at is null and period_from <= $3 and period_to >= $2
          order by created_at desc limit 1`, [req.auth.branchId, from, to]);
      // ضريبة المدخلات (migration 089): حركة 1360 في الفترة، ورصيده المتراكم حتى نهايتها (يشمل المرحَّل)
      const { rows: [iv] } = await c.query(
        `select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end) filter (where (e.created_at at time zone '${TZ}')::date between $2 and $3
                  and e.op_type not in ('vat_settlement', 'vat_settlement_reversal', 'vat_to_hq', 'group_vat_settlement')), 0)::numeric as period,
                coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end) filter (where (e.created_at at time zone '${TZ}')::date <= $3), 0)::numeric as balance
           from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.branch_id = $1 and l.account_code = '1360'`,
        [req.auth.branchId, from, to]);
      const inputVat = roundMoney(Number(iv.period));
      const carriedIn = roundMoney(Math.max(0, Number(iv.balance) - inputVat));
      const outputVat = roundMoney(Number(s.std_vat));
      const adjVat = roundMoney(Number(r.vat));
      const netDue = roundMoney(outputVat - adjVat - inputVat);
      const ledgerNet = roundMoney(Number(g.net));
      return {
        from, to,
        sales: {
          standard: { base: roundMoney(Number(s.std_base)), vat: outputVat, count: s.std_count },
          returns: { base: roundMoney(Number(r.base)), vat: adjVat, count: r.n },
          exempt: { base: roundMoney(Number(s.exempt_base)), count: s.exempt_count },
        },
        purchases: { vat: inputVat, carried: carriedIn, tracked: true },
        netDue, ledgerNet, diff: roundMoney(ledgerNet - (outputVat - adjVat)),
        settlement: st[0] ? { id: st[0].id, from: st[0].period_from, to: st[0].period_to, outputVat: Number(st[0].output_vat), inputVat: Number(st[0].input_vat),
          paid: Number(st[0].paid), source: st[0].source, at: st[0].created_at, toHq: !!st[0].to_hq, groupId: st[0].group_id || null } : null,
        filing: await vatFilingOf(c, req.auth.branchId),
      };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});


// ══ تسوية الإقرار وسداده (migration 086) ══
// قيدٌ واحد: مدين 2220 بضريبة المخرجات للفترة، دائن الخزنة بالمسدَّد. الفترة لا تُسوّى مرتين ما لم تُلغَ
// تسويتها، والإلغاء قيدٌ عكسي بسببٍ مكتوب ويعود المدفوع إلى الخزنة.
const VAT_CASH = { safe_cash: { account: "1110", method: "cash" }, safe_network: { account: "1120", method: "network" } };
// الإقرار الموحّد (migration 092): في «إقرارٌ واحد للمنشأة» يحوّل الفرع صافي ضريبته للإدارة، والإدارة تسدّد الموحّد
async function vatFilingOf(c, branchId) {
  const { rows: [b] } = await c.query(
    "select b.is_hq, coalesce(s.vat_filing, 'branch') as filing from branches b left join stores s on s.id = b.store_id where b.id = $1", [branchId]);
  return { group: b?.filing === "group", isHq: !!b?.is_hq };
}
router.post("/vat-return/settle", authenticate, requirePage("vatReturn"), requireManager, async (req, res, next) => {
  const { from, to } = req.body || {};
  const source = VAT_CASH[req.body?.source] ? req.body.source : "safe_cash";
  if (!DAY.test(String(from || "")) || !DAY.test(String(to || "")) || from > to) return res.status(400).json({ error: "invalid_range" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: dup } = await c.query(
        "select 1 from vat_settlements where branch_id = $1 and reversed_at is null and period_from <= $3 and period_to >= $2 limit 1",
        [req.auth.branchId, from, to]);
      if (dup[0]) return { error: "vat_period_settled" };
      const { rows: [g] } = await c.query(
        `select coalesce(sum(case when l.side = 'credit' then l.amount else -l.amount end), 0)::numeric as net
           from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.branch_id = $1 and l.account_code = '2220' and (e.created_at at time zone '${TZ}')::date between $2 and $3
            and e.op_type not in ('vat_settlement', 'vat_settlement_reversal', 'vat_to_hq', 'group_vat_settlement')`,
        [req.auth.branchId, from, to]);
      const outVat = roundMoney(Number(g.net));
      // المدخلات المتاحة: رصيد 1360 حتى نهاية الفترة (ما بعد التسويات السابقة — يشمل المرحَّل)
      const { rows: [ib] } = await c.query(
        `select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0)::numeric as bal
           from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.branch_id = $1 and l.account_code = '1360' and (e.created_at at time zone '${TZ}')::date <= $2`,
        [req.auth.branchId, to]);
      const inAvail = roundMoney(Math.max(0, Number(ib.bal)));
      if (!(outVat > 0) && !(inAvail > 0)) return { error: "vat_nothing_to_settle" };
      // المقاصّة: المدخلات تُطفئ المخرجات حتى قدرها، والفائض يبقى مرحَّلًا في 1360 للإقرار القادم
      const offset = roundMoney(Math.min(Math.max(0, outVat), inAvail));
      const pay = roundMoney(Math.max(0, outVat) - offset);
      if (!(Math.max(0, outVat) > 0)) return { error: "vat_nothing_to_settle" };
      const { rows: [bal] } = await c.query(
        `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)::numeric as bal
           from cash_tx where branch_id = $1 and pool = 'safe' and method = $2`, [req.auth.branchId, VAT_CASH[source].method]);
      if (pay > 0 && Number(bal.bal) + 0.005 < pay) return { error: "insufficient_safe_balance", available: roundMoney(Number(bal.bal)) };
      const filing = await vatFilingOf(c, req.auth.branchId);
      // الإدارة في الموحّد لا تسوّي هنا — تسدّد الإقرار الموحّد من التطبيق المركزي
      if (filing.group && filing.isHq) return { error: "settle_via_group_vat" };
      const toHq = filing.group;
      const { rows: [row] } = await c.query(
        `insert into vat_settlements (branch_id, period_from, period_to, output_vat, input_vat, paid, source, created_by, to_hq)
         values ($1, $2, $3, $4, $7, $8, $5, $6, $9) returning id`, [req.auth.branchId, from, to, outVat, source, req.auth.userId, offset, pay, toHq]);
      const { rows: [day] } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      if (pay > 0) {
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1, $2, 'safe', $3, 'out', $4, $8, 'vat_settlements', $5, $6, $7)`,
          [req.auth.branchId, day?.id || null, VAT_CASH[source].method, pay, row.id,
           `${toHq ? "تحويل ضريبة القيمة المضافة للإدارة" : "سداد ضريبة القيمة المضافة"} ${from} ← ${to}`, req.auth.userId, toHq ? "vat_to_hq" : "vat_payment"]);
        // الموحّد: المبلغ يصل الإدارة بمعاملة «تحويل نقدي للإدارة» معتمدة — تستلمه فيُقيَّد في دفترها للهيئة (2225)
        if (toHq) {
          const { rows: [tx] } = await c.query(
            `insert into hq_transactions (branch_id, flow, status, amount, note, requested_by_user_id, vat_settlement_id, decided_at)
             values ($1, 'cash_transfer', 'approved', $2, $3, $4, $5, now()) returning id`,
            [req.auth.branchId, pay, `ضريبة القيمة المضافة ${from} ← ${to} — للإقرار الموحّد`, req.auth.userId, row.id]);
          await c.query("update vat_settlements set hq_txn_id = $2 where id = $1", [row.id, tx.id]);
        }
      }
      const entryId = await postJournalEntry(c, {
        branchId: req.auth.branchId, businessDayId: day?.id || null, opType: toHq ? "vat_to_hq" : "vat_settlement", refTable: "vat_settlements", refId: row.id,
        description: `${toHq ? "تحويل ضريبة الفترة للإدارة (إقرار موحّد)" : "تسوية إقرار الضريبة"} ${from} ← ${to}`, createdBy: req.auth.userId,
        lines: [
          { account: "2220", side: "debit", amount: outVat },
          { account: "1360", side: "credit", amount: offset },
          { account: VAT_CASH[source].account, side: "credit", amount: pay },
        ],
      });
      await c.query("update vat_settlements set entry_id = $2 where id = $1", [row.id, entryId]);
      return { settlement: { id: row.id, from, to, outputVat: outVat, inputVat: offset, paid: pay, source, toHq } };
    });
    if (out.error) return res.status(409).json(out);
    res.status(201).json(out);
  } catch (err) {
    if (err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why });
    next(err);
  }
});

router.post("/vat-return/settle/:id/undo", authenticate, requirePage("vatReturn"), requireManager, async (req, res, next) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: [s] } = await c.query(
        "select * from vat_settlements where id = $1 and branch_id = $2 and reversed_at is null for update", [req.params.id, req.auth.branchId]);
      if (!s) return { error: "not_found" };
      // آخر تسويةٍ وحدها تُلغى — إلغاء قديمةٍ تحت أحدث منها يُربك ترحيل الفترات
      const { rows: later } = await c.query(
        "select 1 from vat_settlements where branch_id = $1 and reversed_at is null and period_from > $2 limit 1", [req.auth.branchId, s.period_to]);
      if (later[0]) return { error: "not_latest_settlement" };
      if (s.group_id) return { error: "group_vat_settled" };
      if (s.hq_txn_id) {
        // تحويلٌ للإدارة لم تستلمه بعد يُلغى معه؛ وما استلمته لا يُلغى من الفرع
        const { rows: [tx] } = await c.query("select status from hq_transactions where id = $1", [s.hq_txn_id]);
        if (tx && tx.status === "received") return { error: "vat_received_by_hq" };
        await c.query("update hq_transactions set status = 'rejected', decision_note = $2 where id = $1", [s.hq_txn_id, `أُلغيت تسوية الضريبة — ${reason}`]);
      }
      const src = VAT_CASH[s.source] ? s.source : "safe_cash";
      const amt = roundMoney(Number(s.paid));
      const offset = roundMoney(Number(s.input_vat) || 0);
      const { rows: [day] } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      if (amt > 0 || offset > 0) {
        if (amt > 0) await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1, $2, 'safe', $3, 'in', $4, 'vat_payment', 'vat_settlements', $5, $6, $7)`,
          [req.auth.branchId, day?.id || null, VAT_CASH[src].method, amt, s.id, `إلغاء سداد الضريبة — ${reason}`, req.auth.userId]);
        const entryId = await postJournalEntry(c, {
          branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "vat_settlement_reversal", refTable: "vat_settlements", refId: s.id,
          description: `إلغاء تسوية الضريبة ${String(s.period_from).slice(0, 10)} — ${reason}`, createdBy: req.auth.userId,
          lines: [
            { account: VAT_CASH[src].account, side: "debit", amount: amt },
            { account: "1360", side: "debit", amount: offset },
            { account: "2220", side: "credit", amount: roundMoney(amt + offset) },
          ],
        });
        if (s.entry_id) await c.query("update journal_entries set reversed_of = $2 where id = $1", [entryId, s.entry_id]);
      }
      await c.query("update vat_settlements set reversed_at = now(), reversed_by = $2, reverse_reason = $3 where id = $1", [s.id, req.auth.userId, reason]);
      return { ok: true };
    });
    if (out.error) return res.status(out.error === "not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) {
    if (err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why });
    next(err);
  }
});

export default router;
