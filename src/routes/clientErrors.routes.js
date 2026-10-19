import { Router } from "express";
import crypto from "node:crypto";
import { withBranch, withoutBranch } from "../db.js";
import { authenticate } from "../middleware/auth.js";
import { authenticateStore } from "../middleware/storeAuth.js";

/**
 * مراقبة الأعطال (migration 082): تطبيق الفرع يرسل كل عطلٍ غير معالَج تلقائيًّا، والإدارة تراه بفرعه وعدد مرّاته وتعلّمه «عولج».
 *   POST /client-errors                       — من الفرع (العطل نفسه يُجمَّع بعدّاد)
 *   GET  /store/client-errors?all=1           — الإدارة: المفتوح (أو الكلّ)
 *   POST /store/client-errors/:id/resolve     — الإدارة: عولج
 */
const router = Router();
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

router.post("/client-errors", authenticate, async (req, res, next) => {
  const b = req.body || {};
  const message = clip(b.message, 500);
  if (!message) return res.status(400).json({ error: "message_required" });
  const stack = clip(b.stack, 4000);
  // البصمة من الرسالة وأوّل سطور المكدّس (بلا أرقام الأعمدة المتغيّرة بين البنايات)
  const head = String(stack || "").split("\n").slice(0, 3).join("\n").replace(/:\d+:\d+/g, "");
  const fingerprint = crypto.createHash("sha1").update(`${message}\n${head}`).digest("hex");
  try {
    await withBranch(req.auth.branchId, (c) => c.query(
      `insert into client_errors (branch_id, fingerprint, message, stack, url, app_version, user_agent, last_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (branch_id, fingerprint) do update set count = client_errors.count + 1, last_seen = now(),
         url = excluded.url, app_version = excluded.app_version, last_user_id = excluded.last_user_id, resolved_at = null, resolved_note = null`,
      [req.auth.branchId, fingerprint, message, stack, clip(b.url, 300), clip(b.version, 40), clip(req.headers["user-agent"], 200), req.auth.userId || null]));
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get("/store/client-errors", authenticateStore, async (req, res, next) => {
  const all = req.query.all === "1";
  try {
    const { rows } = await withoutBranch((c) => c.query(
      `select e.id, e.branch_id, b.name as branch_name, b.ref as branch_ref, e.message, e.stack, e.url, e.app_version, e.user_agent,
              e.count, e.first_seen, e.last_seen, e.resolved_at, e.resolved_note, u.name as last_user
         from client_errors e join branches b on b.id = e.branch_id left join users u on u.id = e.last_user_id
        where b.store_id = $1 and b.deleted_at is null and ($2 or e.resolved_at is null)
        order by e.resolved_at nulls first, e.last_seen desc limit 300`, [req.storeAuth.storeId, all]));
    res.json({ errors: rows.map((r) => ({ id: r.id, branchId: r.branch_id, branchName: r.branch_name, branchRef: r.branch_ref, message: r.message,
      stack: r.stack, url: r.url, version: r.app_version, userAgent: r.user_agent, count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen,
      resolvedAt: r.resolved_at, resolvedNote: r.resolved_note, lastUser: r.last_user })) });
  } catch (err) { next(err); }
});

router.post("/store/client-errors/:id/resolve", authenticateStore, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(
      `update client_errors e set resolved_at = now(), resolved_note = $3 from branches b
        where e.id = $1 and b.id = e.branch_id and b.store_id = $2 returning e.id`,
      [req.params.id, req.storeAuth.storeId, clip(req.body?.note, 200)]));
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
