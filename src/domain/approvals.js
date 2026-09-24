import { roundMoney } from "./money.js";

/**
 * بوّابة الاعتماد (approvalGate في المرجع) — على الخادم.
 *
 * ما فوق الحدّ لا يُنفَّذ بل يُحفظ طلبًا بحمولته (payload)، وعند الاعتماد
 * يُعيد المعتمِد إرسال العملية نفسها بـapprovalId فتُنفَّذ **مرةً واحدة**
 * (executed_at يُختم في معاملة التنفيذ نفسها).
 *
 * ⚠ المدير لا يعتمد نفسه إلا إن لم يكن فوقه أحد: في الفرع هو أعلى معتمِد،
 *   فيُنفَّذ طلبه مباشرةً ويُسجَّل اعتمادًا ذاتيًّا — السجل يبقى شاهدًا.
 *
 * يعيد: { proceed: true } | { pending: <approval row> } | { error }
 */
async function approvalGate(client, auth, { kind, amount, payload = null, approvalId = null, note = null }) {
  const amt = roundMoney(amount);
  const branchId = auth.branchId;

  // ① تنفيذ طلبٍ معتمد — مرةً واحدة، وبالمبلغ نفسه
  if (approvalId) {
    const { rows } = await client.query(
      `select * from approvals where id = $1 and branch_id = $2 for update`,
      [approvalId, branchId]
    );
    const ap = rows[0];
    if (!ap || ap.rule_id !== kind) return { error: "approval_not_found" };
    if (ap.executed_at || ap.status === "executed") return { error: "approval_already_executed" };
    if (ap.status !== "approved") return { error: "approval_not_approved", status: ap.status };
    if (Math.abs(Number(ap.amount) - amt) > 0.01) return { error: "approval_amount_mismatch", approved: Number(ap.amount) };
    await client.query(`update approvals set status = 'executed', executed_at = now() where id = $1`, [ap.id]);
    return { proceed: true, approvalId: ap.id };
  }

  const { rows: st } = await client.query(
    "select approvals_enabled, approval_thresholds from branch_settings where branch_id = $1",
    [branchId]
  );
  if (st[0] && st[0].approvals_enabled === false) return { proceed: true };
  const { rows: ruleRows } = await client.query("select * from approval_rules where id = $1", [kind]);
  const rule = ruleRows[0];
  if (!rule) return { proceed: true };
  const custom = st[0]?.approval_thresholds?.[kind];
  const threshold = custom != null && Number.isFinite(Number(custom)) ? Number(custom) : Number(rule.threshold) || 0;
  if (amt < threshold) return { proceed: true };

  const { rows: nRows } = await client.query(
    "select count(*)::int + 1 as n from approvals where branch_id = $1",
    [branchId]
  );
  const ref = `APR-${String(nRows[0].n).padStart(5, "0")}`;
  const selfApprove = auth.role === (rule.approver_role || "manager");
  const { rows: apRows } = await client.query(
    `insert into approvals
       (branch_id, rule_id, status, requested_by, ref, amount, payload, note,
        requester_name, requester_role, approver_kind, self_approved,
        decided_by, decided_at, approver_name, executed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, $9,$10,$11,$12, $13,$14,$15,$16)
     returning *`,
    [
      branchId, kind, selfApprove ? "executed" : "pending", auth.userId, ref, amt,
      payload ? JSON.stringify(payload) : null, note,
      auth.user?.name || null, auth.role || null, rule.approver_role || "manager", selfApprove,
      selfApprove ? auth.userId : null, selfApprove ? new Date() : null,
      selfApprove ? auth.user?.name || null : null, selfApprove ? new Date() : null,
    ]
  );
  if (selfApprove) return { proceed: true, approvalId: apRows[0].id, selfApproved: true };
  return { pending: shapeApproval(apRows[0], rule) };
}

function shapeApproval(a, rule = null) {
  return {
    id: a.id,
    ref: a.ref,
    kind: a.rule_id,
    kindLabel: rule?.label || a.rule_label || a.rule_id,
    amount: Number(a.amount) || 0,
    payload: a.payload || null,
    status: a.status,
    note: a.note || "",
    requester: a.requester_name || "",
    requesterId: a.requested_by,
    requesterRole: a.requester_role || null,
    requestedAt: a.created_at,
    approverKind: a.approver_kind || "manager",
    approver: a.approver_name || null,
    approverId: a.decided_by || null,
    decidedAt: a.decided_at || null,
    decisionNote: a.decision_note || "",
    selfApproved: !!a.self_approved,
    executedAt: a.executed_at || null,
  };
}

export { approvalGate, shapeApproval };
