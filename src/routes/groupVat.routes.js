import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { authenticateStore, requireCanManageBranches } from "../middleware/storeAuth.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";

/**
 * الإقرار الموحّد للمنشأة (migration 092):
 *   GET  /store/group-vat?from&to           لكل فرعٍ مخرجاته ومدخلاته وحالة تحويله، والإجمالي وجاهزية السداد
 *   POST /store/group-vat/filing { filing }  «branch» إقرارٌ لكل فرع · «group» إقرارٌ واحد للمنشأة
 *   POST /store/group-vat/settle { from, to, source }  سداد الموحّد من دفتر الإدارة
 * في الموحّد يسوّي كل فرعٍ إقراره بتحويل صافيه للإدارة (vat_to_hq)، وتستلمه الإدارة في 2225؛ ثم تسدّد الإدارة
 * للهيئة مرّةً واحدة: مدين 2220 (مخرجاتها) و2225 (ما حوّلته الفروع)، دائن 1360 (مدخلاتها) والمصدر بالمسدَّد.
 * لا يُسدَّد شهرٌ فيه فرعٌ له ضريبة لم يحوّلها أو حوّلها ولم تُستلم — والسبب يُعرض بجانبه.
 */
const router = Router();
router.use("/store/group-vat", authenticateStore);
const TZ = "Asia/Riyadh";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SRC = { bank: { account: "1160" }, safe_cash: { account: "1110", method: "cash" }, safe_network: { account: "1120", method: "network" } };
const SKIP_OPS = "('vat_settlement', 'vat_settlement_reversal', 'vat_to_hq', 'group_vat_settlement')";

async function branchVat(c, branchId, from, to) {
  const { rows: [g] } = await c.query(
    `select coalesce(sum(case when l.side = 'credit' then l.amount else -l.amount end), 0)::numeric as net
       from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.branch_id = $1 and l.account_code = '2220' and (e.created_at at time zone '${TZ}')::date between $2 and $3
        and e.op_type not in ${SKIP_OPS}`, [branchId, from, to]);
  const { rows: [iv] } = await c.query(
    `select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end) filter (where (e.created_at at time zone '${TZ}')::date between $2 and $3
              and e.op_type not in ${SKIP_OPS}), 0)::numeric as period,
            coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end) filter (where (e.created_at at time zone '${TZ}')::date <= $3), 0)::numeric as balance
       from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.branch_id = $1 and l.account_code = '1360'`, [branchId, from, to]);
  const { rows: st } = await c.query(
    `select s.*, t.status as txn_status from vat_settlements s left join hq_transactions t on t.id = s.hq_txn_id
      where s.branch_id = $1 and s.reversed_at is null and s.period_from <= $3 and s.period_to >= $2
      order by s.created_at desc limit 1`, [branchId, from, to]);
  return { outputVat: roundMoney(Number(g.net)), inputVat: roundMoney(Number(iv.period)), inputAvail: roundMoney(Math.max(0, Number(iv.balance))), settlement: st[0] || null };
}

async function groupView(storeId, from, to) {
  const { rows: [store] } = await withoutBranch((c) => c.query("select vat_filing from stores where id = $1", [storeId]));
  const { rows: brs } = await withoutBranch((c) => c.query(
    "select id, ref, name, is_hq from branches where store_id = $1 and deleted_at is null order by is_hq desc, created_at", [storeId]));
  const rows = [];
  for (const b of brs) {
    const v = await withBranch(b.id, (c) => branchVat(c, b.id, from, to));
    const s = v.settlement;
    let status = "none";
    if (b.is_hq) status = s?.group_id ? "grouped" : "hq";
    else if (s?.group_id) status = "grouped";
    else if (s && !s.to_hq) status = "self";
    else if (s && (Number(s.paid) <= 0.004 || s.txn_status === "received")) status = "ok";
    else if (s) status = "sent";
    else if (v.outputVat > 0.004) status = "pending";
    rows.push({
      id: b.id, ref: b.ref, name: b.name, isHq: !!b.is_hq, status,
      outputVat: v.outputVat, inputVat: v.inputVat, inputAvail: v.inputAvail, net: roundMoney(v.outputVat - v.inputVat),
      toHq: s && s.to_hq ? roundMoney(Number(s.paid)) : 0, settlementId: s?.id || null, groupId: s?.group_id || null,
    });
  }
  const hq = rows.find((r) => r.isHq) || null;
  const blockers = [];
  if (!hq) blockers.push({ id: null, why: "لا فرع رئيسي للإدارة يُقيَّد فيه الإقرار" });
  for (const r of rows) {
    if (r.status === "pending") blockers.push({ id: r.id, why: `${r.name}: لم يسوِّ إقراره ويحوّل ضريبته` });
    if (r.status === "sent") blockers.push({ id: r.id, why: `${r.name}: حوّل ${r.toHq} ولم تستلمه الإدارة بعد` });
  }
  const grouped = rows.some((r) => r.status === "grouped");
  if (grouped) blockers.push({ id: null, why: "سُدِّد الإقرار الموحّد لهذه الفترة" });
  const branchesTotal = roundMoney(rows.filter((r) => r.status === "ok").reduce((a, r) => a + r.toHq, 0));
  const hqOffset = hq ? roundMoney(Math.min(Math.max(0, hq.outputVat), hq.inputAvail)) : 0;
  const hqPay = hq ? roundMoney(Math.max(0, hq.outputVat) - hqOffset) : 0;
  const counted = rows.filter((r) => r.status !== "self");
  const total = {
    outputVat: roundMoney(counted.reduce((a, r) => a + r.outputVat, 0)),
    inputVat: roundMoney(counted.reduce((a, r) => a + r.inputVat, 0)),
    branchesTotal, hqOutput: hq?.outputVat || 0, hqOffset, hqPay, pay: roundMoney(branchesTotal + hqPay),
  };
  total.net = roundMoney(total.outputVat - total.inputVat);
  const filing = store?.vat_filing === "group" ? "group" : "branch";
  if (filing !== "group") blockers.unshift({ id: null, why: "الإقرار لكل فرعٍ وحده — اختر «إقرارٌ واحد للمنشأة» أوّلًا" });
  const { rows: gs } = await withoutBranch((c) => c.query(
    `select id, period_from::text as period_from, period_to::text as period_to, paid, source, created_at from group_vat_settlements
      where store_id = $1 and period_from <= $3 and period_to >= $2 order by created_at desc limit 1`, [storeId, from, to]));
  return { filing, from, to, rows, total, blockers, ready: !blockers.length && total.pay > 0, settlement: gs[0] || null, hqBranchId: hq?.id || null };
}

router.get("/store/group-vat", async (req, res, next) => {
  const from = String(req.query.from || ""), to = String(req.query.to || "");
  if (!DAY.test(from) || !DAY.test(to) || from > to) return res.status(400).json({ error: "invalid_range" });
  try { res.json(await groupView(req.storeAuth.storeId, from, to)); } catch (err) { next(err); }
});

router.post("/store/group-vat/filing", requireCanManageBranches, async (req, res, next) => {
  const filing = req.body?.filing === "group" ? "group" : "branch";
  try {
    await withoutBranch((c) => c.query("update stores set vat_filing = $2 where id = $1", [req.storeAuth.storeId, filing]));
    res.json({ filing });
  } catch (err) { next(err); }
});

router.post("/store/group-vat/settle", requireCanManageBranches, async (req, res, next) => {
  const { from, to } = req.body || {};
  const source = SRC[req.body?.source] ? req.body.source : "bank";
  if (!DAY.test(String(from || "")) || !DAY.test(String(to || "")) || from > to) return res.status(400).json({ error: "invalid_range" });
  try {
    const G = await groupView(req.storeAuth.storeId, from, to);
    if (!G.ready) return res.status(409).json({ error: "group_vat_not_ready", blockers: G.blockers });
    const hqId = G.hqBranchId;
    const out = await withBranch(hqId, async (c) => {
      const t = G.total;
      if (SRC[source].method) {
        const { rows: [bal] } = await c.query(
          `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0)::numeric as b from cash_tx
            where branch_id = $1 and pool = 'safe' and method = $2`, [hqId, SRC[source].method]);
        if (Number(bal.b) + 0.005 < t.pay) return { error: "insufficient_safe_balance", available: roundMoney(Number(bal.b)) };
      }
      const { rows: [day] } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [hqId]);
      const okRows = G.rows.filter((r) => r.status === "ok");
      const { rows: [gs] } = await c.query(
        `insert into group_vat_settlements (store_id, hq_branch_id, period_from, period_to, hq_output, hq_input, branches_total, paid, source, detail, created_by_store_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [req.storeAuth.storeId, hqId, from, to, t.hqOutput, t.hqOffset, t.branchesTotal, t.pay, source,
         JSON.stringify(G.rows.map((r) => ({ id: r.id, name: r.name, status: r.status, outputVat: r.outputVat, inputVat: r.inputVat, toHq: r.toHq }))), req.storeAuth.storeUserId]);
      // دفتر الإدارة: تسويةٌ باسمها للفترة (فلا تُكرَّر من شاشة الإقرار)، مربوطةٌ بالموحّد
      const { rows: [hs] } = await c.query(
        `insert into vat_settlements (branch_id, period_from, period_to, output_vat, input_vat, paid, source, group_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [hqId, from, to, Math.max(0, t.hqOutput), t.hqOffset, t.pay, source, gs.id]);
      if (SRC[source].method && t.pay > 0) {
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note)
           values ($1,$2,'safe',$3,'out',$4,'vat_payment','group_vat_settlements',$5,$6)`,
          [hqId, day?.id || null, SRC[source].method, t.pay, gs.id, `سداد الإقرار الموحّد ${from} ← ${to}`]);
      }
      const entryId = await postJournalEntry(c, {
        branchId: hqId, businessDayId: day?.id || null, opType: "group_vat_settlement", refTable: "group_vat_settlements", refId: gs.id,
        description: `سداد الإقرار الموحّد للمنشأة ${from} ← ${to}`, createdBy: null,
        lines: [
          { account: "2220", side: "debit", amount: Math.max(0, t.hqOutput) },
          { account: "2225", side: "debit", amount: t.branchesTotal },
          { account: "1360", side: "credit", amount: t.hqOffset },
          { account: SRC[source].account, side: "credit", amount: t.pay },
        ],
      });
      await c.query("update group_vat_settlements set entry_id = $2 where id = $1", [gs.id, entryId]);
      await c.query("update vat_settlements set entry_id = $2 where id = $1", [hs.id, entryId]);
      // تسويات الفروع المحوَّلة تُوسم بالموحّد — لا تُلغى من الفرع بعده
      for (const r of okRows) {
        await c.query("select set_config('app.current_branch_id', $1, true)", [r.id]);
        await c.query("update vat_settlements set group_id = $2 where id = $1", [r.settlementId, gs.id]);
      }
      await c.query("select set_config('app.current_branch_id', $1, true)", [hqId]);
      return { settlement: { id: gs.id, from, to, paid: t.pay, source, branchesTotal: t.branchesTotal, hqPay: t.hqPay }, journalEntryId: entryId };
    });
    if (out.error) return res.status(409).json(out);
    res.status(201).json(out);
  } catch (err) {
    if (err.code === "period_locked") return res.status(409).json({ error: "period_locked", why: err.why });
    next(err);
  }
});

export default router;
