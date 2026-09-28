import crypto from "crypto";
import { logPermission } from "./permissionLog.js";

/// رمز ربط جهاز الموظّف: قصيرٌ يسعه QR، صالحٌ ENROLL_TTL_MIN دقيقة ولمرّةٍ واحدة، ويُخزَّن مُجزَّأً فقط.
///   لا يحمل رقمًا سريًّا — الموظّف يضع رقمه على جهازه. وإصدار رمزٍ جديد يُبطل السابق.
const ENROLL_TTL_MIN = 30;
const ENROLL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeHash = (code) => crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");

/// `actor`: { id, name, kind: "branch" | "store" } · `createdBy`: مستخدم الفرع (null للإدارة)
/// `user` = null ← رمز «جهاز الفرع» المشترك (يبدأ بـOQD1، ولا رقم سري فيه)
async function issueEnrollCode(client, { branchId, user = null, createdBy = null, actor }) {
  const bytes = crypto.randomBytes(10);
  let body = "";
  for (const x of bytes) body += ENROLL_ALPHABET[x % ENROLL_ALPHABET.length];
  const code = `${user ? "OQE1" : "OQD1"}${body}`;
  const expiresAt = new Date(Date.now() + ENROLL_TTL_MIN * 60 * 1000);
  if (user) await client.query("update enroll_invites set used_at = now() where user_id = $1 and used_at is null", [user.id]);
  await client.query(
    `insert into enroll_invites (branch_id, user_id, code_hash, expires_at, created_by, kind) values ($1,$2,$3,$4,$5,$6)`,
    [branchId, user ? user.id : null, codeHash(code), expiresAt, createdBy, user ? "user" : "shared"]);
  await logPermission(client, branchId, { targetId: user?.id || null, targetName: user ? user.name : "جهاز الفرع", kind: "enroll", actor });
  return { code, expiresAt, ttlMin: ENROLL_TTL_MIN, shared: !user, user: user ? { id: user.id, name: user.name, role: user.role } : null };
}

export { ENROLL_ALPHABET, ENROLL_TTL_MIN, codeHash, issueEnrollCode };
