import { verifySession } from "../auth/jwt.js";
import { withoutBranch } from "../db.js";

/**
 * مفتاح المنصة السري (PLATFORM_ADMIN_KEY في متغيرات البيئة).
 *
 * ⚠ بعد لوحة الأدمن الحقيقية (migration 032) لم يعد هذا المفتاح طريقة
 * الدخول اليومية — يُستخدم فقط لإنشاء أول حساب أدمن على منصةٍ جديدة (حين
 * لا يوجد أي حساب بعد)، ويبقى لمسار bootstrap-owner القديم للتوافق.
 * متغيّر غير مضبوط = مقفول كليًّا (503)، لا مفتوحًا لأي طلب.
 */
function requirePlatformAdminKey(req, res, next) {
  const key = req.headers["x-platform-admin-key"];
  if (!process.env.PLATFORM_ADMIN_KEY) {
    return res.status(503).json({ error: "platform_admin_key_not_configured" });
  }
  if (!key || key !== process.env.PLATFORM_ADMIN_KEY) {
    return res.status(401).json({ error: "invalid_platform_admin_key" });
  }
  next();
}

/**
 * جلسة أدمن المنصة — نظير authenticate/authenticateStore لكن لـscope
 * "platform". يتحقق من الحساب في القاعدة عند كل طلب (لا من التوكن وحده):
 * أدمن عُطِّل حسابه يُرفض فورًا، لا بعد انتهاء صلاحية توكنه (12 ساعة).
 */
async function authenticatePlatform(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing_token" });

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }
  if (payload.scope !== "platform") {
    return res.status(401).json({ error: "wrong_token_scope" });
  }

  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, name, email from platform_admins where id = $1 and active = true`,
        [payload.sub]
      )
    );
    if (!rows[0]) return res.status(401).json({ error: "admin_not_found_or_inactive" });
    req.platformAuth = { adminId: rows[0].id, name: rows[0].name, email: rows[0].email };
    next();
  } catch (err) {
    next(err);
  }
}

export { requirePlatformAdminKey, authenticatePlatform };
