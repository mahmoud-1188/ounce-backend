import { Router } from "express";
import crypto from "crypto";
import { withBranch, withoutBranch } from "../db.js";
import { authenticate, requireAnyPage, requireManager, requirePage } from "../middleware/auth.js";
import { hashPin, verifyPin } from "../auth/hashPin.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";
import { shapeApproval } from "../domain/approvals.js";
import { logPermission } from "../domain/permissionLog.js";
import { monthRange, recordedNetworkFees, settleBankFeePeriod, shapeAdjustment } from "../domain/bankFees.js";

const router = Router();

/**
 * الرقابة وقسم المحاسب (migration 037):
 *   المراجعة المحاسبية · الاعتمادات · قفل الفترات وحدود الاعتماد ·
 *   سجل الصلاحيات · دعوات ربط الجهاز · تسوية عمولة البنك.
 */

// ══ ① المراجعة المحاسبية — أحكامٌ تُضاف ولا تُعدَّل ══════════════════
const VERDICTS = ["approved", "needs_change", "note"];

function shapeReview(r) {
  return {
    id: r.id, key: r.key, kind: r.kind, targetId: r.target_id, targetRef: r.target_ref,
    targetDate: r.target_date, label: r.label, why: r.why, amount: Number(r.amount) || 0,
    verdict: r.verdict, note: r.note || "", fingerprint: r.fingerprint || "",
    reviewer: r.reviewer_name || "", reviewerId: r.reviewer_id, reviewerRole: r.reviewer_role,
    date: r.created_at, businessDayId: r.business_day_id,
  };
}

router.get("/reviews", authenticate, requirePage("accountantReview"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select * from reviews where branch_id = $1 order by created_at desc limit 1000",
        [req.auth.branchId]
      );
      return rows;
    });
    res.json({ reviews: rows.map(shapeReview) });
  } catch (err) {
    next(err);
  }
});

router.post("/reviews", authenticate, requirePage("accountantReview"), async (req, res, next) => {
  const b = req.body || {};
  // ⚖ الحكم بيد المحاسب أو المدير — والقراءة لمن يملك الشاشة
  if (!["accountant", "manager"].includes(req.auth.role)) return res.status(403).json({ error: "reviewer_role_required" });
  if (!VERDICTS.includes(b.verdict)) return res.status(400).json({ error: "invalid_verdict" });
  if (!b.key || !b.kind) return res.status(400).json({ error: "invalid_review_target" });
  const note = String(b.note || "").trim();
  if (b.verdict !== "approved" && !note) return res.status(400).json({ error: "review_note_required" });
  if (b.kind === "stocktake_variance" && !note) return res.status(400).json({ error: "stocktake_reason_required" });
  try {
    const row = await withBranch(req.auth.branchId, async (client) => {
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const { rows } = await client.query(
        `insert into reviews
           (branch_id, key, kind, target_id, target_ref, target_date, label, why, amount,
            verdict, note, fingerprint, reviewer_id, reviewer_name, reviewer_role, business_day_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, $10,$11,$12,$13,$14,$15,$16)
         returning *`,
        [
          req.auth.branchId, String(b.key), String(b.kind), b.targetId != null ? String(b.targetId) : null,
          b.targetRef || null, b.targetDate || null, b.label || null, b.why || null, roundMoney(b.amount),
          b.verdict, note || null, b.fingerprint || null, req.auth.userId, req.auth.user?.name || null,
          req.auth.role, day?.id || null,
        ]
      );
      return rows[0];
    });
    res.status(201).json({ review: shapeReview(row) });
  } catch (err) {
    next(err);
  }
});

// ══ ② الاعتمادات ══════════════════════════════════════════════════════
router.get("/approvals", authenticate, requireAnyPage("approvals", "accountantReview", "expenses", "salesReturn"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select a.*, r.label as rule_label from approvals a
           left join approval_rules r on r.id = a.rule_id
          where a.branch_id = $1 order by a.created_at desc limit 300`,
        [req.auth.branchId]
      );
      return rows;
    });
    // من لا يملك شاشة الاعتمادات يرى طلباته وحده
    const all = (req.auth.allowedPages || []).includes("approvals");
    res.json({
      approvals: rows.filter((a) => all || a.requested_by === req.auth.userId).map((a) => shapeApproval(a, { label: a.rule_label })),
    });
  } catch (err) {
    next(err);
  }
});

// القرار نهائي: لا يُقرَّر الطلب ثانية. التنفيذ بعده يعيد إرسال العملية
// نفسها بـapprovalId (راجع domain/approvals.js).
router.post("/approvals/:id/decide", authenticate, requirePage("approvals"), requireManager, async (req, res, next) => {
  const decision = req.body?.decision;
  const note = String(req.body?.note || "").trim();
  if (!["approved", "rejected"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
  if (decision === "rejected" && !note) return res.status(400).json({ error: "rejection_reason_required" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select a.*, r.label as rule_label from approvals a left join approval_rules r on r.id = a.rule_id
          where a.id = $1 and a.branch_id = $2 for update of a`,
        [req.params.id, req.auth.branchId]
      );
      const ap = rows[0];
      if (!ap) return { error: "approval_not_found" };
      if (ap.status !== "pending") return { error: "approval_already_decided", status: ap.status };
      // ما جعلته الإدارة لنفسها يُقرَّر في لوحة الإدارة لا في الفرع
      if (ap.approver_kind === "hq") return { error: "approval_requires_hq" };
      const { rows: upd } = await client.query(
        `update approvals set status = $1, decided_by = $2, decided_at = now(), approver_name = $3, decision_note = $4
          where id = $5 returning *`,
        [decision, req.auth.userId, req.auth.user?.name || null, note || null, ap.id]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,$2,$3,'approvals',$4,$5)`,
        [req.auth.branchId, decision === "approved" ? "approve" : "reject", req.auth.userId, ap.id,
          JSON.stringify({ ref: ap.ref, kind: ap.rule_id, amount: Number(ap.amount), note })]
      );
      return { approval: shapeApproval({ ...upd[0], rule_label: ap.rule_label }, { label: ap.rule_label }) };
    });
    if (result.error) return res.status(result.error === "approval_not_found" ? 404 : result.error === "approval_requires_hq" ? 403 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══ ③ حدود الاعتماد وقفل الفترات ═════════════════════════════════════
router.patch("/settings/controls", authenticate, requirePage("settings"), requireManager, async (req, res, next) => {
  const b = req.body || {};
  const date = (v) => (v == null || v === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined);
  const lockAll = date(b.lockAll);
  const lockPosted = date(b.lockPosted);
  if (lockAll === undefined || lockPosted === undefined) return res.status(400).json({ error: "invalid_lock_date" });
  let thresholds = null;
  if (b.approvalThresholds != null) {
    if (typeof b.approvalThresholds !== "object") return res.status(400).json({ error: "invalid_thresholds" });
    thresholds = {};
    for (const [k, v] of Object.entries(b.approvalThresholds)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "invalid_thresholds", kind: k });
      thresholds[k] = roundMoney(n);
    }
  }
  try {
    const row = await withBranch(req.auth.branchId, async (client) => {
      const { rows: cur } = await client.query("select * from branch_settings where branch_id = $1", [req.auth.branchId]);
      const c = cur[0] || {};
      const { rows } = await client.query(
        `insert into branch_settings (branch_id, approvals_enabled, approval_thresholds, lock_all, lock_posted)
         values ($1,$2,$3,$4,$5)
         on conflict (branch_id) do update set
           approvals_enabled = excluded.approvals_enabled,
           approval_thresholds = excluded.approval_thresholds,
           lock_all = excluded.lock_all,
           lock_posted = excluded.lock_posted
         returning approvals_enabled, approval_thresholds, lock_all::text as lock_all, lock_posted::text as lock_posted`,
        [
          req.auth.branchId,
          b.approvalsEnabled != null ? !!b.approvalsEnabled : c.approvals_enabled !== false,
          JSON.stringify(thresholds || c.approval_thresholds || {}),
          b.lockAll !== undefined ? lockAll : c.lock_all || null,
          b.lockPosted !== undefined ? lockPosted : c.lock_posted || null,
        ]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ controls: rows[0] })]
      );
      return rows[0];
    });
    res.json({ controls: row });
  } catch (err) {
    next(err);
  }
});

// ══ ④ سجل الصلاحيات ══════════════════════════════════════════════════
router.get("/permission-log", authenticate, requirePage("access"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select * from permission_log where branch_id = $1 order by created_at desc limit 500",
        [req.auth.branchId]
      );
      return rows;
    });
    res.json({
      log: rows.map((r) => ({
        id: r.id, targetId: r.target_id, target: r.target_name, kind: r.kind,
        before: r.before, after: r.after, added: r.added || [], removed: r.removed || [],
        by: r.actor_name || "", byKind: r.actor_kind, date: r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ══ ⑤ ربط جهاز الموظّف بـQR ══════════════════════════════════════════
// الرمز قصير (يسعه QR) ومن أبجدية كبيرة؛ يُخزَّن مُجزَّأً فقط، صالحٌ
// ENROLL_TTL_MIN دقيقة ولمرةٍ واحدة. لا يحمل رقمًا سريًّا — الموظّف يضعه.
const ENROLL_TTL_MIN = 30;
const ENROLL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeHash = (code) => crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");

router.post("/users/:id/enroll-invite", authenticate, requirePage("access"), requireManager, async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select id, name, role from users where id = $1 and branch_id = $2 and active = true",
        [req.params.id, req.auth.branchId]
      );
      const u = rows[0];
      if (!u) return { error: "not_found" };
      // ⚠ دور المدير تُصدره الإدارة وحدها: لولا ذلك لربط أي مديرٍ مديرًا آخر
      if (u.role === "manager" && u.id !== req.auth.userId) return { error: "manager_enroll_requires_hq" };
      const bytes = crypto.randomBytes(10);
      let body = "";
      for (const x of bytes) body += ENROLL_ALPHABET[x % ENROLL_ALPHABET.length];
      const code = `OQE1${body}`;
      const expiresAt = new Date(Date.now() + ENROLL_TTL_MIN * 60 * 1000);
      await client.query(
        "update enroll_invites set used_at = now() where user_id = $1 and used_at is null",
        [u.id]
      );
      await client.query(
        `insert into enroll_invites (branch_id, user_id, code_hash, expires_at, created_by)
         values ($1,$2,$3,$4,$5)`,
        [req.auth.branchId, u.id, codeHash(code), expiresAt, req.auth.userId]
      );
      await logPermission(client, req.auth.branchId, {
        targetId: u.id, targetName: u.name, kind: "enroll",
        actor: { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" },
      });
      return { code, expiresAt, ttlMin: ENROLL_TTL_MIN, user: { id: u.id, name: u.name, role: u.role } };
    });
    if (result.error) return res.status(result.error === "not_found" ? 404 : 403).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// عامّ (بلا توكن): الموظّف على جهازه، والفرع معروف من رابط الدخول.
router.post("/enroll/claim", async (req, res, next) => {
  const { branchId, code, pin } = req.body || {};
  if (!branchId || !code) return res.status(400).json({ error: "code_required" });
  if (!/^\d{4,6}$/.test(String(pin || ""))) return res.status(400).json({ error: "pin_must_be_4_to_6_digits" });
  try {
    const result = await withBranch(branchId, async (client) => {
      const { rows } = await client.query(
        `select i.*, u.name, u.active from enroll_invites i join users u on u.id = i.user_id
          where i.branch_id = $1 and i.code_hash = $2 for update of i`,
        [branchId, codeHash(code)]
      );
      const inv = rows[0];
      if (!inv || !inv.active) return { error: "invalid_enroll_code" };
      if (inv.used_at) return { error: "enroll_code_used" };
      if (new Date(inv.expires_at).getTime() < Date.now()) return { error: "enroll_code_expired" };
      // الرقم لا يتكرّر في الفرع (نفس حارس إضافة المستخدم)
      const { rows: others } = await client.query(
        "select id, pin_hash from users where branch_id = $1 and active = true and id <> $2",
        [branchId, inv.user_id]
      );
      for (const o of others) if (await verifyPin(String(pin), o.pin_hash)) return { error: "pin_taken" };
      await client.query("update users set pin_hash = $1 where id = $2", [await hashPin(String(pin)), inv.user_id]);
      await client.query("update enroll_invites set used_at = now() where id = $1", [inv.id]);
      await logPermission(client, branchId, {
        targetId: inv.user_id, targetName: inv.name, kind: "enroll",
        after: { claimed: true }, actor: { id: inv.user_id, name: inv.name, kind: "self" },
      });
      return { ok: true, user: { id: inv.user_id, name: inv.name } };
    });
    if (result.error) return res.status(result.error === "pin_taken" ? 409 : 400).json(result);
    res.json(result);
  } catch (err) {
    // فرعٌ غير صالح (uuid خاطئ) — لا نكشف السبب
    if (err && err.code === "22P02") return res.status(400).json({ error: "invalid_enroll_code" });
    next(err);
  }
});

// ══ ⑥ تسوية عمولة البنك — مرّةً للشهر (domain/bankFees.js) ════════════
router.get("/bank-fees", authenticate, requirePage("bankFees"), async (req, res, next) => {
  const period = String(req.query.period || new Date().toISOString().slice(0, 7));
  const range = monthRange(period);
  if (!range) return res.status(400).json({ error: "invalid_period" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const recorded = await recordedNetworkFees(client, req.auth.branchId, range);
      const { rows } = await client.query(
        "select * from bank_fee_adjustments where branch_id = $1 order by period desc",
        [req.auth.branchId]
      );
      return { period, recorded, adjustments: rows.map(shapeAdjustment) };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/bank-fees/settle", authenticate, requirePage("bankFees"), requireManager, async (req, res, next) => {
  const period = String(req.body?.period || "");
  const actual = roundMoney(req.body?.actualFee);
  const note = String(req.body?.note || "").trim() || null;
  if (!monthRange(period)) return res.status(400).json({ error: "invalid_period" });
  if (!(actual >= 0)) return res.status(400).json({ error: "invalid_amount" });
  try {
    const result = await withBranch(req.auth.branchId, (client) =>
      settleBankFeePeriod(client, req.auth.branchId, { period, actual, note, userId: req.auth.userId, userName: req.auth.user?.name || null })
    );
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
