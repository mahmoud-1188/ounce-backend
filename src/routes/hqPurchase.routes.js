import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { authenticateStore, requireCanManageBranches } from "../middleware/storeAuth.js";
import { shapeApproval } from "../domain/approvals.js";
import { ensureSupplier, parseHqPurchase, runHqPurchase } from "../domain/hqPurchase.js";

const router = Router();

/**
 * شراء الإدارة على حساب فرع (migration 048):
 *   POST /store/branches/:id/hq-purchase { supplierName, payFrom, lines, note, requireApproval }
 *        بموافقة المدير ← طلب اعتماد في الفرع (hq_purchase) · بلاها ← يُنفَّذ الآن
 *   POST /hq-purchase/execute { approvalId } — مدير الفرع ينفّذ ما وافق عليه
 */
router.post("/store/branches/:id/hq-purchase", authenticateStore, requireCanManageBranches, async (req, res, next) => {
  const p = parseHqPurchase(req.body || {});
  if (p.error) return res.status(400).json(p);
  const actor = req.storeAuth.name || "الإدارة";
  try {
    const { rows: br } = await withoutBranch((c) => c.query(
      "select id, name from branches where id = $1 and store_id = $2 and deleted_at is null", [req.params.id, req.storeAuth.storeId]));
    if (!br[0]) return res.status(404).json({ error: "branch_not_found" });
    const branchId = br[0].id;

    if (p.requireApproval) {
      const approval = await withBranch(branchId, async (c) => {
        const { rows: n } = await c.query("select count(*)::int + 1 as n from approvals where branch_id = $1", [branchId]);
        const { rows } = await c.query(
          `insert into approvals (branch_id, rule_id, status, requested_by, ref, amount, payload, note, requester_name, requester_role, approver_kind)
           values ($1,'hq_purchase','pending',null,$2,$3,$4,$5,$6,'hq','manager') returning *`,
          [branchId, `APR-${String(n[0].n).padStart(5, "0")}`, p.total, JSON.stringify({ supplierName: p.supplierName, payFrom: p.payFrom, lines: p.lines, note: p.note, by: actor }),
           `${p.supplierName}${p.note ? ` · ${p.note}` : ""}`, actor]
        );
        await c.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',null,'approvals',$2,$3)`,
          [branchId, rows[0].id, JSON.stringify({ hqPurchase: true, total: p.total, by: actor, byKind: "store" })]
        );
        return shapeApproval(rows[0], { label: "شراء من الإدارة على حساب الفرع" });
      });
      return res.status(202).json({ approvalPending: approval, branch: br[0].name });
    }

    const supplierId = await withBranch(branchId, (c) => ensureSupplier(c, branchId, p.supplierName));
    const r = await runHqPurchase({ branchId, actorName: actor, p, supplierId });
    if (r.status >= 400) return res.status(r.status).json(r.body);
    res.status(201).json({ ...r.body, branch: br[0].name });
  } catch (err) {
    next(err);
  }
});

router.post("/hq-purchase/execute", authenticate, requireManager, async (req, res, next) => {
  const approvalId = req.body?.approvalId;
  if (!approvalId) return res.status(400).json({ error: "approval_not_found" });
  try {
    // ① الطلب يُختم «نُفّذ» في معاملته، ويُفكّ الختم إن رفض معالج الشراء (رصيدٌ لا يكفي مثلًا)
    const claim = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query("select * from approvals where id = $1 and branch_id = $2 for update", [approvalId, req.auth.branchId]);
      const ap = rows[0];
      if (!ap || ap.rule_id !== "hq_purchase") return { error: "approval_not_found" };
      if (ap.executed_at || ap.status === "executed") return { error: "approval_already_executed" };
      if (ap.status !== "approved") return { error: "approval_not_approved", status: ap.status };
      await c.query("update approvals set status = 'executed', executed_at = now() where id = $1", [ap.id]);
      return { ap };
    });
    if (claim.error) return res.status(409).json(claim);
    const ap = claim.ap;
    const p = parseHqPurchase({ ...(ap.payload || {}), requireApproval: false });
    if (p.error) return res.status(400).json(p);
    const supplierId = await withBranch(req.auth.branchId, (c) => ensureSupplier(c, req.auth.branchId, p.supplierName));
    const r = await runHqPurchase({ branchId: req.auth.branchId, actorUserId: req.auth.userId, actorName: ap.payload?.by || "الإدارة", role: req.auth.role, p, supplierId, ref: ap.ref });
    if (r.status >= 400) {
      await withBranch(req.auth.branchId, (c) => c.query("update approvals set status = 'approved', executed_at = null where id = $1", [ap.id]));
      return res.status(r.status).json(r.body);
    }
    res.status(201).json(r.body);
  } catch (err) {
    next(err);
  }
});

export default router;
