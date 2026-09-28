import crypto from "crypto";
import { logPermission } from "./permissionLog.js";

/// رمز ربط جهاز الموظّف: قصيرٌ يسعه QR، صالحٌ ENROLL_TTL_MIN دقيقة ولمرّةٍ واحدة، ويُخزَّن مُجزَّأً فقط.
///   لا يحمل رقمًا سريًّا — الموظّف يضع رقمه على جهازه. وإصدار رمزٍ جديد يُبطل السابق.
const ENROLL_TTL_MIN = 30;
const ENROLL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codeHash = (code) => crypto.createHash("sha256").update(String(code).trim().toUpperCase()).digest("hex");

/// `actor`: { id, name, kind: "branch" | "store" } · `createdBy`: مستخدم الفرع (null للإدارة)
async function issueEnrollCode(client, { branchId, user, createdBy = null, actor }) {
  const bytes = crypto.randomBytes(10);
  let body = "";
  for (const x of bytes) body += ENROLL_ALPHABET[x % ENROLL_ALPHABET.length];
  const code = `OQE1${body}`;
  const expiresAt = new Date(Date.now() + ENROLL_TTL_MIN * 60 * 1000);
  await client.query("update enroll_invites set used_at = now() where user_id = $1 and used_at is null", [user.id]);
  await client.query(
    `insert into enroll_invites (branch_id, user_id, code_hash, expires_at, created_by) values ($1,$2,$3,$4,$5)`,
    [branchId, user.id, codeHash(code), expiresAt, createdBy]);
  await logPermission(client, branchId, { targetId: user.id, targetName: user.name, kind: "enroll", actor });
  return { code, expiresAt, ttlMin: ENROLL_TTL_MIN, user: { id: user.id, name: user.name, role: user.role } };
}

export { ENROLL_ALPHABET, ENROLL_TTL_MIN, codeHash, issueEnrollCode };
