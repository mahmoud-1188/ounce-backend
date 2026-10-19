import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage, requireManager } from "../middleware/auth.js";
import { postJournalEntry } from "../domain/journal.js";
import { fineWeight } from "../domain/weight.js";
import { approvalGate, shapeApproval } from "../domain/approvals.js";
import { branchDelegation } from "../domain/delegation.js";
import { roundMoney } from "../domain/money.js";

/**
 * فترة التجهيز وبدء التشغيل (migration 073).
 * التسلسل الإلزامي: تكويد البضاعة القديمة (أو «لا بضاعة قديمة») ← الرصيد الافتتاحي محفوظًا ← بدء التشغيل.
 * في الفرع المرتبط بالإدارة يعتمد بدءَ التشغيل الإدارةُ دائمًا — لا يُلغيه «بلا موافقات» ولا التفويض الكامل.
 */
const router = Router();

async function setupState(client, branchId) {
  const { rows } = await client.query(
    `select coalesce(ledger_state, 'live') as ledger_state, opening_balance, opening_saved_at, no_old_stock, go_live_at, go_live_date
       from branch_settings where branch_id = $1`, [branchId]);
  const s = rows[0] || { ledger_state: "live" };
  const { rows: pc } = await client.query(
    `select count(*)::int as n from item_units u join items i on i.id = u.item_id where i.branch_id = $1`, [branchId]);
  const { rows: sx } = await client.query(
    `select count(*)::int as n, coalesce(sum(i.weight), 0) as w from item_units u join items i on i.id = u.item_id
      where i.branch_id = $1 and u.exit_ref is not null`, [branchId]);
  const { rows: ap } = await client.query(
    `select a.*, r.label as rule_label from approvals a left join approval_rules r on r.id = a.rule_id
      where a.branch_id = $1 and a.rule_id = 'go_live' and a.status in ('pending', 'approved')
      order by a.created_at desc limit 1`, [branchId]);
  return {
    ledgerState: s.ledger_state === "setup" ? "setup" : "live",
    codedPieces: pc[0]?.n || 0,
    noOldStock: !!s.no_old_stock,
    openingSaved: !!s.opening_saved_at,
    openingSavedAt: s.opening_saved_at || null,
    openingBalance: s.opening_balance || null,
    goLiveAt: s.go_live_at || null,
    goLiveDate: s.go_live_date || null,
    exited: { pieces: sx[0]?.n || 0, weight: Number(sx[0]?.w) || 0 },
    request: ap[0] ? shapeApproval(ap[0], { label: ap[0].rule_label }) : null,
  };
}

// سبب رفض بدء التشغيل بالترتيب، أو null
function sequenceRefusal(st) {
  if (st.ledgerState !== "setup") return "already_live";
  if (!st.codedPieces && !st.noOldStock) return "code_old_stock_first";
  if (!st.openingSaved) return "opening_balance_first";
  return null;
}

router.get("/setup/state", authenticate, async (req, res, next) => {
  try {
    const st = await withBranch(req.auth.branchId, (c) => setupState(c, req.auth.branchId));
    const d = await withBranch(req.auth.branchId, (c) => branchDelegation(c, req.auth.branchId));
    res.json({ ...st, linked: d.linked, refusal: st.ledgerState === "setup" ? sequenceRefusal(st) : null });
  } catch (err) { next(err); }
});

// الرصيد الافتتاحي في التجهيز مسوّدةٌ بلا قيد — ويُرفض قبل تكويد البضاعة القديمة إلا بعلَم «لا بضاعة قديمة»
router.post("/setup/opening-balance", authenticate, requireManager, async (req, res, next) => {
  const b = req.body || {};
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const st = await setupState(c, req.auth.branchId);
      const noOld = b.noOldStock === true;
      if (st.ledgerState === "setup" && !st.codedPieces && !noOld) return { error: "code_old_stock_first" };
      await c.query(
        `insert into branch_settings (branch_id, opening_balance, opening_saved_at, no_old_stock)
         values ($1, $2, now(), $3)
         on conflict (branch_id) do update set opening_balance = excluded.opening_balance, opening_saved_at = now(), no_old_stock = excluded.no_old_stock`,
        [req.auth.branchId, JSON.stringify(b.balance || {}), noOld]);
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ action: "opening_balance_saved", noOldStock: noOld, setup: st.ledgerState === "setup" })]);
      return setupState(c, req.auth.branchId);
    });
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

// بيعٌ بلا سعر في فترة التجهيز: قطعةٌ من البضاعة القديمة بِيعت قبل التشغيل تخرج من المخزون بلا فاتورةٍ ولا قيد،
//   وتنقص من الافتتاحي المؤجَّل فلا تدخل الدفاتر يوم البدء. تُوسم issued برقم إخراجٍ SX- وأثرها في التدقيق.
router.post("/setup/exit-units", authenticate, requireAnyPage("sales", "addGoods"), async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 200);
  const note = String(req.body?.note || "").trim().slice(0, 160);
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const st = await setupState(c, req.auth.branchId);
      if (st.ledgerState !== "setup") return { error: "already_live" };
      const { rows } = await c.query(
        `select u.id, u.code, u.sold, u.issued, u.held, i.weight, i.cost_per_gram, i.workmanship, l.id as lot_id, l.source, l.opening_posted
           from item_units u join items i on i.id = u.item_id left join lots l on l.id = i.lot_id
          where i.branch_id = $1 and upper(u.code) = any($2::text[]) for update of u`, [req.auth.branchId, codes]);
      if (rows.length !== codes.length) {
        const have = new Set(rows.map((r) => r.code.toUpperCase()));
        return { error: "unit_not_found", code: codes.find((x) => !have.has(x)) };
      }
      for (const r of rows) {
        if (r.sold || r.issued || r.held) return { error: "unit_not_available", code: r.code };
        if (r.source !== "opening" || r.opening_posted !== false) return { error: "not_opening_stock", code: r.code };
      }
      const { rows: nr } = await c.query(
        `select count(distinct exit_ref)::int + 1 as n from item_units u join items i on i.id = u.item_id
          where i.branch_id = $1 and u.exit_ref is not null`, [req.auth.branchId]);
      const ref = `SX-${String(nr[0].n).padStart(4, "0")}`;
      await c.query(
        `update item_units set issued = true, issued_at = now(), issued_by = $2, exit_ref = $3, exit_note = $4 where id = any($1::uuid[])`,
        [rows.map((r) => r.id), req.auth.userId, ref, note || "بيع قبل التشغيل — بلا سعر"]);
      const byLot = new Map();
      for (const r of rows) {
        const g = byLot.get(r.lot_id) || { w: 0, gold: 0, total: 0 };
        g.w += Number(r.weight); g.gold += (Number(r.cost_per_gram) || 0) * Number(r.weight);
        g.total += (Number(r.cost_per_gram) || 0) * Number(r.weight) + (Number(r.workmanship) || 0);
        byLot.set(r.lot_id, g);
      }
      for (const [lotId, g] of byLot) await c.query(
        `update lots set weight = greatest(0, coalesce(weight, 0) - $2), gold_cost = greatest(0, coalesce(gold_cost, 0) - $3),
                         total_cost = greatest(0, coalesce(total_cost, 0) - $4) where id = $1`,
        [lotId, g.w, roundMoney(g.gold), roundMoney(g.total)]);
      const weight = Math.round(rows.reduce((a, r) => a + Number(r.weight), 0) * 1000) / 1000;
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'delete',$2,'item_units',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ action: "setup_exit", ref, codes, weight, note: note || null })]);
      return { ok: true, ref, count: rows.length, weight };
    });
    if (out.error) return res.status(out.error === "unit_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

// قيد الافتتاح المؤجَّل: ما كُوِّد في التجهيز يدخل الدفاتر يوم البدء (1210 ← 3100) بوزنه وعياره
async function postDeferredOpening(client, branchId, userId) {
  const { rows: lots } = await client.query(
    `select id, ref, karat, coalesce(weight, 0) as weight, coalesce(total_cost, 0) as total_cost from lots
      where branch_id = $1 and source = 'opening' and opening_posted = false for update`, [branchId]);
  for (const lot of lots) {
    const w = Number(lot.weight) || 0, value = Number(lot.total_cost) || 0;
    if (w > 0) {
      await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1, null, 'opening_inventory', $2, $3, $4, null, '1210', 'lots', $5, $6, $7)`,
        [branchId, lot.karat, w, fineWeight(w, lot.karat), lot.id, `افتتاحي ${lot.ref} — بدء التشغيل`, userId]);
    }
    if (value > 0) {
      await postJournalEntry(client, {
        branchId, businessDayId: null, opType: "opening_inventory", refTable: "lots", refId: lot.id,
        description: `مخزون افتتاحي مكوَّد — ${lot.ref} — بدء التشغيل`, createdBy: userId,
        lines: [{ account: "1210", side: "debit", amount: value }, { account: "3100", side: "credit", amount: value }],
      });
    }
    await client.query("update lots set opening_posted = true where id = $1", [lot.id]);
  }
  return lots.length;
}

router.post("/setup/go-live", authenticate, requireManager, async (req, res, next) => {
  const b = req.body || {};
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.startDate || "")) ? String(b.startDate) : new Date().toISOString().slice(0, 10);
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const st = await setupState(c, req.auth.branchId);
      const why = sequenceRefusal(st);
      if (why) return { error: why };
      const d = await branchDelegation(c, req.auth.branchId);
      if (d.linked) {
        if (!b.approvalId) {
          if (st.request?.status === "pending") return { error: "go_live_pending", request: st.request };
          // ⚖ تعتمده الإدارة دائمًا: لا يمرّ بحدود الفرع ولا بتفويضه
          const { rows: nRows } = await c.query("select count(*)::int + 1 as n from approvals where branch_id = $1", [req.auth.branchId]);
          const { rows } = await c.query(
            `insert into approvals (branch_id, rule_id, status, requested_by, ref, amount, payload, note, requester_name, requester_role, approver_kind)
             values ($1, 'go_live', 'pending', $2, $3, 0, $4, $5, $6, $7, 'hq') returning *`,
            [req.auth.branchId, req.auth.userId, `APR-${String(nRows[0].n).padStart(5, "0")}`,
              JSON.stringify({ startDate, codedPieces: st.codedPieces, noOldStock: st.noOldStock }),
              String(b.note || "").slice(0, 200) || `بدء التشغيل من ${startDate}`, req.auth.user?.name || null, req.auth.role || null]);
          return { approvalPending: shapeApproval(rows[0], { label: "بدء التشغيل" }) };
        }
        const gate = await approvalGate(c, req.auth, { kind: "go_live", amount: 0, approvalId: b.approvalId });
        if (gate.error) return gate;
      }
      const posted = await postDeferredOpening(c, req.auth.branchId, req.auth.userId);
      await c.query(
        `update branch_settings set ledger_state = 'live', go_live_at = now(), go_live_date = $2 where branch_id = $1`,
        [req.auth.branchId, startDate]);
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ action: "go_live", startDate, postedLots: posted })]);
      return { live: true, startDate, postedLots: posted };
    });
    if (out.approvalPending) return res.status(202).json(out);
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

export default router;
export { setupState };
