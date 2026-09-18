import { Router } from "express";
import { withoutBranch } from "../db.js";
import { verifyPassword, hashPassword } from "../auth/hashPassword.js";
import { signStoreSession } from "../auth/jwt.js";
import { authenticateStore } from "../middleware/storeAuth.js";

const router = Router();

/**
 * ⚠⚠ مؤقت بصراحة (طلب المستخدم صراحةً): لا يوجد تطبيق أدمن
 * حقيقي للمنصة بعد — من يخوّل من يفتح حساب متجر جديد سؤال تصميمي لم
 * يُحسم بعد (راجع محادثة إضافة migration 020_stores_multi_tenant.sql). هذا
 * المسار مؤقت حصرًا لفتح أول حساب مالك متجر للاختبار، محمي بمفتاح
 * سري في متغيّر بيئة (PLATFORM_ADMIN_KEY) لا بأي جلسة مستخدم عادية —
 * وليس بديلًا عن لوحة تحكّم أدمن حقيقية (إدارة اشتراكات، متاجر متعددة،
 * تدقيق صلاحيات). يُزال ويُستبدل بلوحة أدمن حقيقية عند بنائها.
 */
function requirePlatformAdminKey(req, res, next) {
  const key = req.headers["x-platform-admin-key"];
  if (!process.env.PLATFORM_ADMIN_KEY) {
    // ⚠ رفض لا سماح ضمني: متغيّر بيئة غير مضبوط يعني هذا المسار
    // مقفول كليًّا — لا مفتوحًا لأي طلب.
    return res.status(503).json({ error: "platform_admin_key_not_configured" });
  }
  if (!key || key !== process.env.PLATFORM_ADMIN_KEY) {
    return res.status(401).json({ error: "invalid_platform_admin_key" });
  }
  next();
}

/**
 * POST /api/store-auth/login  { email, password }
 *
 * ⚠ منفصل عمدًا عن /api/auth/login (دخول مستخدم الفرع بالـPIN) — هوية
 * مختلفة جذريًّا (store_users لا users)، فمسارٌ منفصل أوضح من فرعٍ واحدٍ
 * يتفرّع بشرطٍ لنوع المستخدم. راجع migration 022_store_users.sql للسبب
 * الكامل، وراجع auth/jwt.js لدالة signStoreSession.
 */
router.post("/store-auth/login", async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  try {
    // ⚠ مقيد بstore_status/subscription_expires_at من أول خطوة عمدًا — بلاه كان مالك متجرة
    // موقوفة/منتهية سيستطيع الدخول وأخذ توكن صالح طالما لم يستخدمه بعد ذلك
    // (authenticateStore يرفضه فقط عند أول طلب لاحق) — تجربة مربكة لا لزوم لها.
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select su.*, s.status as store_status, s.subscription_expires_at
           from store_users su
           join stores s on s.id = su.store_id
          where su.email = $1 and su.active = true`,
        [String(email).trim()]
      )
    );
    const storeUser = rows[0];
    if (!storeUser) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const ok = await verifyPassword(password, storeUser.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    if (storeUser.store_status !== "active") {
      return res.status(403).json({ error: `store_${storeUser.store_status}` });
    }
    if (
      storeUser.subscription_expires_at &&
      new Date(storeUser.subscription_expires_at).getTime() < Date.now()
    ) {
      return res.status(403).json({ error: "subscription_expired" });
    }
    const token = signStoreSession(storeUser);
    res.json({
      token,
      storeUser: {
        id: storeUser.id,
        name: storeUser.name,
        role: storeUser.role,
        storeId: storeUser.store_id,
        allowedPages: storeUser.allowed_pages,
        canManageBranches: !!storeUser.can_manage_branches,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/store-auth/me
 * نظير /api/auth/me لاستعادة الجلسة المركزية عند إعادة تحميل الصفحة —
 * نفس السبب الموثَّق هناك (auth.routes.js) بالضبط.
 */
router.get("/store-auth/me", authenticateStore, (req, res) => {
  res.json({
    storeUser: {
      id: req.storeAuth.storeUserId,
      name: req.storeAuth.name,
      role: req.storeAuth.role,
      storeId: req.storeAuth.storeId,
      allowedPages: req.storeAuth.allowedPages,
      canManageBranches: req.storeAuth.canManageBranches,
    },
  });
});

/**
 * POST /api/store-auth/bootstrap-owner  { storeId, name, email, password }
 * (رأس x-platform-admin-key: <PLATFORM_ADMIN_KEY>)
 *
 * ينشئ أول حساب owner لمتجر موجود أصلًا في stores — لا ينشئ
 * متجرًا جديدًا (ذلك عمل لوحة الأدمن الحقيقية لاحقًا). مؤقتٌ
 * بطبيعته: لا يمنع إنشاء owner ثانٍ لنفس المتجر (ليس قيدًا واحدًا،
 * لوحة الأدمن الحقيقية ستقرر ذلك لاحقًا).
 */
router.post("/store-auth/bootstrap-owner", requirePlatformAdminKey, async (req, res, next) => {
  const { storeId, name, email, password } = req.body || {};
  if (!storeId || !name || !email || !password) {
    return res.status(400).json({ error: "storeId, name, email and password are required" });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }
  try {
    const { rows: storeRows } = await withoutBranch((client) =>
      client.query(`select id from stores where id = $1`, [storeId])
    );
    if (!storeRows[0]) {
      return res.status(404).json({ error: "store_not_found" });
    }

    const passwordHash = await hashPassword(password);
    const { rows } = await withoutBranch((client) =>
      client.query(
        `insert into store_users (store_id, name, email, password_hash, role)
         values ($1, $2, $3, $4, 'owner')
         returning id, store_id, name, email, role`,
        [storeId, String(name).trim(), String(email).trim(), passwordHash]
      )
    );
    res.status(201).json({ storeUser: rows[0] });
  } catch (err) {
    // ⚠ قيد email الفريد في schema يرفض بريدًا مكررًا بخطأ 23505 —
    // رسالة واضحة لا رمز خطأ عام.
    if (err.code === "23505") {
      return res.status(409).json({ error: "email_already_used" });
    }
    next(err);
  }
});

export default router;
