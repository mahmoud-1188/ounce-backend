import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { authenticateStore, requireCanManageBranches } from "../middleware/storeAuth.js";
import { roundMoney } from "../domain/money.js";
import { roundWeight } from "../domain/weight.js";
import { shapeApproval } from "../domain/approvals.js";
import { monthRange, recordedNetworkFees, settleBankFeePeriod } from "../domain/bankFees.js";
import { buildServerReviewQueue } from "../domain/reviewQueueServer.js";
import { postManualAdjustment, reverseJournalEntry } from "../domain/journalOps.js";
import { ACTION_GROUPS, BRANCH_SCREENS, HQ_ACTIONS, sanitizePolicy } from "../domain/hqPolicy.js";

const router = Router();

/**
 * لوحة الإدارة (HqConsolePage في المرجع) — ما تراه الإدارة وتفعله على
 * فروعها من قاعدة البيانات مباشرةً، لا من لقطاتٍ يرسلها الفرع:
 *
 *   التنبيهات · الميزان الموحّد · مصروفات الفروع وتوزيع عمولة البنك ·
 *   أهداف المبيعات · من يعتمد ماذا وصندوق الاعتمادات · دفاتر الفرع ·
 *   حسابات الفرع عن بعد (أحكام المراجعة · عكس قيد · قيد تسوية · عمولة البنك).
 *
 * ⚠ كل مسارٍ مقيّد بمتجر المستخدم المركزي (store_id)، وما يمسّ فرعًا بعينه
 *   يتحقّق أولًا أنه من فروع المتجر — كنمط assertBranchInStore.
 */
router.use("/store", authenticateStore);

const actorOf = (req) => req.storeAuth.name || "الإدارة";

async function storeBranches(storeId) {
  const { rows } = await withoutBranch((client) =>
    client.query(
      "select id, ref, name, is_hq, target30 from branches where store_id = $1 and deleted_at is null order by name",
      [storeId]
    )
  );
  return rows;
}

async function branchOfStore(storeId, branchId) {
  const { rows } = await withoutBranch((client) =>
    client.query("select id, ref, name from branches where id = $1 and store_id = $2 and deleted_at is null", [branchId, storeId])
  );
  return rows[0] || null;
}

// ⚠ معرّفٌ غير صالح (uuid) يرمي 22P02 — نُعيده «غير موجود» لا 500
const notFoundOn22P02 = (err, res, next) => (err && err.code === "22P02" ? res.status(404).json({ error: "not_found" }) : next(err));

// ══ ① يحتاج انتباهك الآن ═══════════════════════════════════════════════
router.get("/store/alerts", async (req, res, next) => {
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const alerts = [];
    for (const b of branches) {
      const push = (level, kind, label, page) => alerts.push({ branchId: b.id, name: b.name, level, kind, label, page });
      const r = await withBranch(b.id, async (c) => {
        const q = async (sql, args = [b.id]) => (await c.query(sql, args)).rows;
        const [last] = await q("select max(created_at) as at from journal_entries where branch_id = $1");
        const [stale] = await q("select ref, opened_at from business_days where branch_id = $1 and status = 'open' and opened_at::date < current_date order by opened_at limit 1");
        const neg = await q(`select l.account_code as code, a.name, sum(case when l.side = 'debit' then l.amount else -l.amount end) as bal
            from journal_lines l join journal_entries e on e.id = l.entry_id left join accounts a on a.code = l.account_code
           where e.branch_id = $1 and l.account_code in ('1110','1120','1130','1140','1150')
           group by 1, 2 having sum(case when l.side = 'debit' then l.amount else -l.amount end) < -0.01`);
        const aps = await q(`select a.ref, a.amount, a.approver_kind, a.created_at, coalesce(r.label, a.rule_id) as label
            from approvals a left join approval_rules r on r.id = a.rule_id
           where a.branch_id = $1 and a.status = 'pending' order by a.created_at`);
        const [ar] = await q(`select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as bal
            from journal_lines l join journal_entries e on e.id = l.entry_id where e.branch_id = $1 and l.account_code = '1310'`);
        const [mtd] = await q("select coalesce(sum(total), 0) as t from sales where branch_id = $1 and date >= date_trunc('month', now())");
        const [dead] = await q(`select count(*)::int as n, coalesce(sum(i.weight), 0) as w from item_units u join items i on i.id = u.item_id
           where i.branch_id = $1 and not u.sold and not u.issued and i.date_added < now() - interval '120 days'`);
        return { wrapped: { last, stale, neg, aps, ar, mtd, dead } };
      });
      const { last, stale, neg, aps, ar, mtd, dead } = r.wrapped;
      neg.forEach((a) => push("block", "negative_cash", `${a.name || a.code} سالب ${roundMoney(a.bal)}`, "accounts"));
      if (stale) push("warn", "day_stale", `يوم عملٍ مفتوح منذ ${stale.opened_at.toISOString().slice(0, 10)} (${stale.ref})`, "ops");
      const dayAgo = Date.now() - 86400000;
      aps.forEach((a) => {
        if (a.approver_kind === "hq") push("warn", "approval_hq", `طلب ${a.label} ${roundMoney(a.amount)} ينتظر قرار الإدارة (${a.ref})`, "approvals");
        else if (new Date(a.created_at).getTime() < dayAgo) push("warn", "approval_stale", `طلب ${a.label} ${roundMoney(a.amount)} ينتظر منذ يوم (${a.ref})`, "approvals");
      });
      if (Number(ar.bal) > 0.01 && Number(ar.bal) > Number(mtd.t)) push("warn", "ar_high", `ذمم آجلة ${roundMoney(ar.bal)} تفوق مبيعات الشهر ${roundMoney(mtd.t)}`, "accounts");
      if (dead.n > 0) push("info", "dead_stock", `بضاعة راكدة: ${dead.n} قطعة (${roundWeight(dead.w)} جم) لم تتحرّك 120 يومًا`, "books");
      if (!last.at) push("info", "no_activity", "لا حركة في دفاتره بعد", "ops");
      else {
        const days = Math.floor((Date.now() - new Date(last.at).getTime()) / 86400000);
        if (days >= 3) push("info", "silent", `لا حركة منذ ${days} يومًا`, "ops");
      }
    }
    const order = { block: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => order[a.level] - order[b.level]);
    res.json({ alerts });
  } catch (err) {
    next(err);
  }
});

// ══ ② الميزان الموحّد ══════════════════════════════════════════════════
//
// أرصدة كل الحسابات حتى تاريخٍ، مجمّعةً ومفصّلةً على الفروع — والمركز
// الذهبي صافيًا (جم24) من دفتر الوزن.
router.get("/store/consolidated", async (req, res, next) => {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "")) ? req.query.to : new Date().toISOString().slice(0, 10);
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const ids = branches.map((b) => b.id);
    if (!ids.length) return res.json({ to, branches: [], accounts: [], totalDebit: 0, totalCredit: 0, balanced: true, goldTotal: 0 });
    const out = await withoutBranch(async (c) => {
      const { rows: bal } = await c.query(
        `select e.branch_id, l.account_code as code,
                coalesce(sum(case when l.side = 'debit' then l.amount end), 0) as debit,
                coalesce(sum(case when l.side = 'credit' then l.amount end), 0) as credit
           from journal_lines l join journal_entries e on e.id = l.entry_id
          where e.branch_id = any($1::uuid[]) and e.created_at < ($2::date + 1)
          group by 1, 2`,
        [ids, to]
      );
      const { rows: gold } = await c.query(
        `select branch_id,
                coalesce(sum(case when to_account like '1%' then fine_weight else 0 end), 0)
                  - coalesce(sum(case when from_account like '1%' then fine_weight else 0 end), 0) as net
           from gold_ledger_entries where branch_id = any($1::uuid[]) and created_at < ($2::date + 1)
          group by 1`,
        [ids, to]
      );
      const { rows: stats } = await c.query(
        `select branch_id, count(*)::int as entries, max(created_at) as last_at from journal_entries
          where branch_id = any($1::uuid[]) group by 1`,
        [ids]
      );
      const { rows: accts } = await c.query("select code, name from accounts");
      return { bal, gold, stats, accts };
    });
    const name = new Map(out.accts.map((a) => [a.code, a.name]));
    const bname = new Map(branches.map((b) => [b.id, b.name]));
    const byAcc = new Map();
    let td = 0, tc = 0;
    for (const r of out.bal) {
      const net = roundMoney(Number(r.debit) - Number(r.credit));
      td += Number(r.debit); tc += Number(r.credit);
      const a = byAcc.get(r.code) || { code: r.code, name: name.get(r.code) || r.code, total: 0, branches: [] };
      a.total = roundMoney(a.total + net);
      if (Math.abs(net) > 0.004) a.branches.push({ branchId: r.branch_id, name: bname.get(r.branch_id), balance: net });
      byAcc.set(r.code, a);
    }
    const accounts = [...byAcc.values()].filter((a) => Math.abs(a.total) > 0.004 || a.branches.length)
      .map((a) => ({ ...a, branches: a.branches.sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance)) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const goldBy = new Map(out.gold.map((g) => [g.branch_id, roundWeight(g.net)]));
    const statBy = new Map(out.stats.map((s) => [s.branch_id, s]));
    res.json({
      to,
      branches: branches.map((b) => ({ id: b.id, name: b.name, goldNet: goldBy.get(b.id) || 0,
        entries: statBy.get(b.id)?.entries || 0, lastAt: statBy.get(b.id)?.last_at || null })),
      accounts,
      totalDebit: roundMoney(td), totalCredit: roundMoney(tc),
      balanced: Math.abs(td - tc) < 0.01,
      goldTotal: roundWeight([...goldBy.values()].reduce((a, v) => a + v, 0)),
    });
  } catch (err) {
    next(err);
  }
});

// ══ ③ مصروفات الفروع — حساب × فرع ═════════════════════════════════════
function periodFrom(p) {
  const now = new Date();
  if (p === "d30") return new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  if (p === "ytd") return `${now.getFullYear()}-01-01`;
  if (p === "all") return "2000-01-01";
  return `${now.toISOString().slice(0, 7)}-01`;
}

router.get("/store/expenses-matrix", async (req, res, next) => {
  const period = ["d30", "mtd", "ytd", "all"].includes(req.query.period) ? req.query.period : "mtd";
  const from = periodFrom(period);
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const ids = branches.map((b) => b.id);
    const { rows, accts } = await withoutBranch(async (c) => ({
      rows: ids.length ? (await c.query(
        `select e.branch_id, l.account_code as code, sum(case when l.side = 'debit' then l.amount else -l.amount end) as amount
           from journal_lines l join journal_entries e on e.id = l.entry_id
          where e.branch_id = any($1::uuid[]) and l.account_code like '6%' and e.created_at >= $2::date
          group by 1, 2`,
        [ids, from]
      )).rows : [],
      accts: (await c.query("select code, name from accounts")).rows,
    }));
    const name = new Map(accts.map((a) => [a.code, a.name]));
    const byAcc = new Map();
    const byBranch = new Map(branches.map((b) => [b.id, 0]));
    for (const r of rows) {
      const v = roundMoney(r.amount);
      if (Math.abs(v) < 0.005) continue;
      const a = byAcc.get(r.code) || { code: r.code, name: name.get(r.code) || r.code, total: 0, byBranch: {} };
      a.total = roundMoney(a.total + v);
      a.byBranch[r.branch_id] = v;
      byAcc.set(r.code, a);
      byBranch.set(r.branch_id, roundMoney((byBranch.get(r.branch_id) || 0) + v));
    }
    const grand = roundMoney([...byBranch.values()].reduce((a, v) => a + v, 0));
    res.json({
      period, from,
      grand,
      branches: branches.map((b) => ({ id: b.id, name: b.name, total: byBranch.get(b.id) || 0 })).sort((a, b) => b.total - a.total),
      accounts: [...byAcc.values()].sort((a, b) => b.total - a.total),
    });
  } catch (err) {
    next(err);
  }
});

// ⚖ عمولة البنك مركزيًّا: كشف بنكٍ واحد للمنشأة — العمولة الفعلية للشهر
//   تُوزَّع على الفروع بنسبة ما سجّله كلٌّ منها على 6500، وتُسوّى في كل فرع.
router.get("/store/bank-fees", async (req, res, next) => {
  const period = String(req.query.period || new Date().toISOString().slice(0, 7));
  const range = monthRange(period);
  if (!range) return res.status(400).json({ error: "invalid_period" });
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const rows = [];
    for (const b of branches) {
      const r = await withBranch(b.id, async (c) => {
        const recorded = await recordedNetworkFees(c, b.id, range);
        const { rows: done } = await c.query("select actual, diff, created_by_name from bank_fee_adjustments where branch_id = $1 and period = $2", [b.id, period]);
        return { recorded, settled: done[0] ? { actual: Number(done[0].actual), diff: Number(done[0].diff), by: done[0].created_by_name || "" } : null };
      });
      rows.push({ branchId: b.id, name: b.name, ...r });
    }
    res.json({ period, branches: rows, recordedTotal: roundMoney(rows.reduce((a, r) => a + r.recorded, 0)) });
  } catch (err) {
    next(err);
  }
});

/// يوزّع مبلغًا بالهللة على أوزانٍ — والباقي من التقريب على الأكبر
function allocate(total, weights) {
  const h = Math.round(total * 100);
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((h * w) / sum));
  let rest = h - raw.reduce((a, v) => a + v, 0);
  const order = weights.map((w, i) => [w, i]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) raw[order[k]] += 1;
  return raw.map((v) => v / 100);
}

router.post("/store/bank-fees/distribute", requireCanManageBranches, async (req, res, next) => {
  const period = String(req.body?.period || "");
  const actual = roundMoney(req.body?.actualFee);
  const note = String(req.body?.note || "").trim() || null;
  const range = monthRange(period);
  if (!range) return res.status(400).json({ error: "invalid_period" });
  if (!(actual >= 0)) return res.status(400).json({ error: "invalid_amount" });
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const recorded = [];
    for (const b of branches) {
      const v = await withBranch(b.id, async (c) => ({ v: await recordedNetworkFees(c, b.id, range) }));
      recorded.push(v.v);
    }
    const total = recorded.reduce((a, v) => a + v, 0);
    if (!(total > 0)) return res.status(409).json({ error: "no_recorded_fees" });
    const shares = allocate(actual, recorded.map((v) => Math.max(0, v)));
    const results = [];
    for (let i = 0; i < branches.length; i++) {
      const b = branches[i];
      if (!(recorded[i] > 0)) { results.push({ branchId: b.id, name: b.name, skipped: "no_fees" }); continue; }
      const r = await withBranch(b.id, (c) =>
        settleBankFeePeriod(c, b.id, { period, actual: shares[i], note: `توزيع مركزي من كشف البنك${note ? ` · ${note}` : ""}`, userId: null, userName: actorOf(req) })
      );
      results.push({ branchId: b.id, name: b.name, share: shares[i], recorded: recorded[i], ...(r.error ? { error: r.error } : { adjustment: r.adjustment }) });
    }
    res.json({ period, actual, recordedTotal: roundMoney(total), results });
  } catch (err) {
    next(err);
  }
});

// ══ ⑤ أهداف المبيعات ═══════════════════════════════════════════════════
router.get("/store/targets", async (req, res, next) => {
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const ids = branches.map((b) => b.id);
    const { rows } = await withoutBranch((c) =>
      c.query(
        "select branch_id, coalesce(sum(total), 0) as s from sales where branch_id = any($1::uuid[]) and date >= now() - interval '30 days' group by 1",
        [ids]
      )
    );
    const s30 = new Map(rows.map((r) => [r.branch_id, roundMoney(r.s)]));
    res.json({ branches: branches.map((b) => {
      const target = Number(b.target30) || 0;
      const sales30 = s30.get(b.id) || 0;
      return { id: b.id, name: b.name, target30: target, sales30, pct: target > 0 ? Math.round((sales30 / target) * 1000) / 10 : null };
    }) });
  } catch (err) {
    next(err);
  }
});

router.patch("/store/branches/:branchId/target", requireCanManageBranches, async (req, res, next) => {
  const t = Number(req.body?.target30);
  if (!Number.isFinite(t) || t < 0) return res.status(400).json({ error: "invalid_target" });
  try {
    const { rows } = await withoutBranch((c) =>
      c.query("update branches set target30 = $1 where id = $2 and store_id = $3 and deleted_at is null returning id, target30",
        [roundMoney(t), req.params.branchId, req.storeAuth.storeId])
    );
    if (!rows[0]) return res.status(404).json({ error: "branch_not_found" });
    res.json({ id: rows[0].id, target30: Number(rows[0].target30) });
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

// ══ ⑥ من يعتمد ماذا + صندوق الاعتمادات ═════════════════════════════════
const ROUTABLE = ["expense", "refund", "supplier_settle"];

router.get("/store/approval-routing", async (req, res, next) => {
  try {
    const { routing, rules } = await withoutBranch(async (c) => ({
      routing: (await c.query("select approval_routing from stores where id = $1", [req.storeAuth.storeId])).rows[0]?.approval_routing || {},
      rules: (await c.query("select id, label, threshold from approval_rules where id = any($1::text[])", [ROUTABLE])).rows,
    }));
    res.json({ rules: ROUTABLE.map((id) => {
      const r = rules.find((x) => x.id === id) || { id, label: id, threshold: 0 };
      return { id, label: r.label, threshold: Number(r.threshold) || 0, approver: routing[id] === "hq" ? "hq" : "branch" };
    }) });
  } catch (err) {
    next(err);
  }
});

router.put("/store/approval-routing", requireCanManageBranches, async (req, res, next) => {
  const body = req.body?.routing || {};
  const routing = {};
  for (const id of ROUTABLE) routing[id] = body[id] === "hq" ? "hq" : "branch";
  try {
    await withoutBranch((c) => c.query("update stores set approval_routing = $1 where id = $2", [JSON.stringify(routing), req.storeAuth.storeId]));
    res.json({ routing });
  } catch (err) {
    next(err);
  }
});

router.get("/store/approvals", async (req, res, next) => {
  const onlyPending = req.query.status !== "all";
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const ids = branches.map((b) => b.id);
    const bname = new Map(branches.map((b) => [b.id, b.name]));
    const { rows } = await withoutBranch((c) =>
      c.query(
        `select a.*, r.label as rule_label from approvals a left join approval_rules r on r.id = a.rule_id
          where a.branch_id = any($1::uuid[]) ${onlyPending ? "and a.status = 'pending'" : ""}
          order by a.created_at desc limit 200`,
        [ids]
      )
    );
    res.json({ approvals: rows.map((a) => ({ ...shapeApproval(a, { label: a.rule_label }), branchId: a.branch_id, branchName: bname.get(a.branch_id) || "" })) });
  } catch (err) {
    next(err);
  }
});

// القرار من الإدارة — ثم ينفّذه الفرع (يُعاد إرسال العملية بـapprovalId فتُنفَّذ مرّةً)
router.post("/store/approvals/:id/decide", requireCanManageBranches, async (req, res, next) => {
  const decision = req.body?.decision;
  const note = String(req.body?.note || "").trim();
  if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
  if (decision === "rejected" && !note) return res.status(400).json({ error: "rejection_reason_required" });
  try {
    const { rows: found } = await withoutBranch((c) =>
      c.query(
        `select a.branch_id from approvals a join branches b on b.id = a.branch_id
          where a.id = $1 and b.store_id = $2 and b.deleted_at is null`,
        [req.params.id, req.storeAuth.storeId]
      )
    );
    if (!found[0]) return res.status(404).json({ error: "approval_not_found" });
    const branchId = found[0].branch_id;
    const result = await withBranch(branchId, async (c) => {
      const { rows } = await c.query(
        `select a.*, r.label as rule_label from approvals a left join approval_rules r on r.id = a.rule_id
          where a.id = $1 for update of a`,
        [req.params.id]
      );
      const ap = rows[0];
      if (ap.status !== "pending") return { error: "approval_already_decided", status: ap.status };
      const { rows: upd } = await c.query(
        `update approvals set status = $1, decided_at = now(), approver_name = $2, decided_by_hq = $2, decision_note = $3
          where id = $4 returning *`,
        [decision, actorOf(req), note || null, ap.id]
      );
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,$2,null,'approvals',$3,$4)`,
        [branchId, decision === "approved" ? "approve" : "reject", ap.id,
          JSON.stringify({ ref: ap.ref, kind: ap.rule_id, amount: Number(ap.amount), note, by: actorOf(req), byKind: "store" })]
      );
      return { approval: shapeApproval({ ...upd[0], rule_label: ap.rule_label }, { label: ap.rule_label }) };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

// ══ ⑦⑧ الشاشات والعمليات — ما تمنعه الإدارة أو تمنحه لكل دور ═══════════
router.get("/store/hq-policy", async (req, res, next) => {
  try {
    const out = await withoutBranch(async (c) => ({
      store: (await c.query("select hq_policy, hq_policy_at, hq_policy_by from stores where id = $1", [req.storeAuth.storeId])).rows[0] || {},
      roles: (await c.query("select id, label from roles order by id")).rows,
    }));
    const branches = await storeBranches(req.storeAuth.storeId);
    res.json({
      policy: { byRole: out.store.hq_policy?.byRole || {}, byBranch: out.store.hq_policy?.byBranch || {} },
      at: out.store.hq_policy_at || null, by: out.store.hq_policy_by || null,
      roles: out.roles, branches: branches.map((b) => ({ id: b.id, name: b.name })),
      screens: BRANCH_SCREENS, actions: HQ_ACTIONS, actionGroups: ACTION_GROUPS,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/store/hq-policy", requireCanManageBranches, async (req, res, next) => {
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const { rows: roles } = await withoutBranch((c) => c.query("select id from roles"));
    const policy = sanitizePolicy(req.body?.policy || {}, { roles: roles.map((r) => r.id), branchIds: branches.map((b) => b.id) });
    const { rows } = await withoutBranch((c) =>
      c.query("update stores set hq_policy = $1, hq_policy_at = now(), hq_policy_by = $2 where id = $3 returning hq_policy_at",
        [JSON.stringify(policy), actorOf(req), req.storeAuth.storeId])
    );
    res.json({ policy, at: rows[0]?.hq_policy_at || null, by: actorOf(req) });
  } catch (err) {
    next(err);
  }
});

// ══ ⑫ دفاتر الفرع — تصفّحٌ للقراءة ═════════════════════════════════════
const BOOKS = {
  sales: `select ref, date as at, customer_name as party, payment_method as method, total as amount, seller_name as by
            from sales where branch_id = $1 order by date desc limit 200`,
  returns: `select ref, created_at as at, customer_name as party, refund_source as method, amount, reason as note
              from returns where branch_id = $1 order by created_at desc limit 200`,
  cash: `select created_at as at, pool, method, direction, amount, category, note
           from cash_tx where branch_id = $1 order by created_at desc limit 200`,
  purchases: `select p.ref, p.created_at as at, s.name as party, p.payment_method as method, p.grand_total as amount,
                     p.total_weight as weight, p.invoice_pending
                from purchases p left join suppliers s on s.id = p.supplier_id
               where p.branch_id = $1 order by p.created_at desc limit 200`,
  expenses: `select ref, created_at as at, name as party, category, funding_source as method, amount, note
               from expenses where branch_id = $1 order by created_at desc limit 200`,
  receipts: `select ref, created_at as at, customer_name as party, method, amount, note
               from receipts where branch_id = $1 order by created_at desc limit 200`,
  scrap: `select ref, created_at as at, coalesce(customer_name, description) as party, coalesce(weight_final, weight_est) as weight,
                 coalesce(karat_final, karat_est) as karat, stage, total_paid as amount
            from scrap_items where branch_id = $1 order by created_at desc limit 200`,
  users: `select name, ref, role, active, salary, created_at as at from users where branch_id = $1 order by active desc, name`,
};

router.get("/store/branches/:branchId/books", async (req, res, next) => {
  const kind = String(req.query.kind || "sales");
  if (!BOOKS[kind]) return res.status(400).json({ error: "invalid_kind" });
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const { rows } = await withBranch(req.params.branchId, (c) => c.query(BOOKS[kind], [req.params.branchId]));
    res.json({ kind, rows });
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

// ══ ⑬ حسابات الفرع عن بعد ══════════════════════════════════════════════
// دليل الحسابات (للقيد اليدوي من الإدارة) — الحسابات الفرعية فقط
router.get("/store/accounts", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query("select code, name, is_group, unit from accounts order by code"));
    res.json({ accounts: rows.filter((a) => !a.is_group && a.unit !== "gram").map((a) => ({ code: a.code, name: a.name })) });
  } catch (err) {
    next(err);
  }
});

router.get("/store/branches/:branchId/review-queue", async (req, res, next) => {
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, async (c) => ({ q: await buildServerReviewQueue(c, req.params.branchId) }));
    res.json({ queue: r.q });
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

const VERDICTS = ["approved", "needs_change", "note"];
router.post("/store/branches/:branchId/reviews", requireCanManageBranches, async (req, res, next) => {
  const b = req.body || {};
  const note = String(b.note || "").trim();
  if (!VERDICTS.includes(b.verdict)) return res.status(400).json({ error: "invalid_verdict" });
  if (!b.key || !b.kind) return res.status(400).json({ error: "invalid_review_target" });
  if (b.verdict !== "approved" && !note) return res.status(400).json({ error: "review_note_required" });
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const { rows } = await withBranch(req.params.branchId, (c) =>
      c.query(
        `insert into reviews (branch_id, key, kind, target_id, target_ref, target_date, label, why, amount,
                              verdict, note, fingerprint, reviewer_id, reviewer_name, reviewer_role, reviewer_kind)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,null,$13,'hq','store') returning id, created_at`,
        [req.params.branchId, String(b.key), String(b.kind), b.targetId != null ? String(b.targetId) : null, b.targetRef || null,
          b.targetDate || null, b.label || null, b.why || null, roundMoney(b.amount), b.verdict, note || null, b.fingerprint || null, actorOf(req)]
      )
    );
    res.status(201).json({ review: { id: rows[0].id, date: rows[0].created_at, verdict: b.verdict, reviewer: actorOf(req) } });
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

router.get("/store/branches/:branchId/journal", async (req, res, next) => {
  const limit = Math.max(1, Math.min(300, Number(req.query.limit) || 100));
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const { rows } = await withBranch(req.params.branchId, (c) =>
      c.query(
        `select e.id, e.created_at, e.op_type, e.description, e.reversed_of, coalesce(pr.label, e.op_type) as label,
                u.name as created_by_name,
                exists (select 1 from journal_entries r where r.reversed_of = e.id) as reversed,
                (select json_agg(json_build_object('account', l.account_code, 'side', l.side, 'amount', l.amount)) from journal_lines l where l.entry_id = e.id) as lines
           from journal_entries e left join posting_rules pr on pr.op_type = e.op_type left join users u on u.id = e.created_by
          where e.branch_id = $1 order by e.created_at desc limit $2`,
        [req.params.branchId, limit]
      )
    );
    res.json({ entries: rows.map((e) => ({
      id: e.id, ref: e.id.slice(0, 8).toUpperCase(), date: e.created_at, opType: e.op_type, label: e.label,
      note: e.description || "", by: e.created_by_name || "", isReversal: !!e.reversed_of, reversed: e.reversed,
      lines: (e.lines || []).map((l) => ({ account: l.account, debit: l.side === "debit" ? Number(l.amount) : 0, credit: l.side === "credit" ? Number(l.amount) : 0 })),
    })) });
  } catch (err) {
    notFoundOn22P02(err, res, next);
  }
});

router.post("/store/branches/:branchId/journal/:entryId/reverse", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const result = await withBranch(req.params.branchId, (c) =>
      reverseJournalEntry(c, req.params.branchId, req.params.entryId, { reason: req.body?.reason, createdBy: null, actorName: `من الإدارة (${actorOf(req)})` })
    );
    if (result.error) return res.status(result.error === "entry_not_found" ? 404 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    if (err && err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why || null });
    notFoundOn22P02(err, res, next);
  }
});

router.post("/store/branches/:branchId/adjustment", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const result = await withBranch(req.params.branchId, (c) =>
      postManualAdjustment(c, req.params.branchId, {
        lines: Array.isArray(req.body?.lines) ? req.body.lines : [], note: req.body?.note,
        createdBy: null, actorName: `قيد تسوية من الإدارة (${actorOf(req)})`,
      })
    );
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    if (err && err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why || null });
    notFoundOn22P02(err, res, next);
  }
});

router.post("/store/branches/:branchId/bank-fees/settle", requireCanManageBranches, async (req, res, next) => {
  const period = String(req.body?.period || "");
  const actual = roundMoney(req.body?.actualFee);
  if (!monthRange(period)) return res.status(400).json({ error: "invalid_period" });
  if (!(actual >= 0)) return res.status(400).json({ error: "invalid_amount" });
  try {
    if (!(await branchOfStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const result = await withBranch(req.params.branchId, (c) =>
      settleBankFeePeriod(c, req.params.branchId, { period, actual, note: String(req.body?.note || "").trim() || null, userId: null, userName: actorOf(req) })
    );
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    if (err && err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why || null });
    notFoundOn22P02(err, res, next);
  }
});

export default router;
