import { Router } from "express";
import { withoutBranch } from "../db.js";
import { verifyPin } from "../auth/hashPin.js";
import { signSession } from "../auth/jwt.js";
import { authenticate, storeBlockReason } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/branches/by-ref/:ref
 *
 * ⚠ يحل رمز فرعٍ عام (branches.ref، مثل BR-A1B2C3D4 — نفس الرمز المولَّد
 * تلقائيًا عند إنشاء الفرع من ounce-central، راجع POST /store/branches)
 * إلى {branchId, branchName} — علنيٌّ بلا مصادقة عمدًا، تمامًا كنظيره
 * GET /branches/:branchId/users أدناه: هذا ما يستدعيه تطبيق الفرع أول
 * مرة يُفتح فيها رابط الفرع (مثل /b/BR-A1B2C3D4) على جهاز جديد، أي
 * *قبل* أي تسجيل دخول، ليعرف أي فرعٍ يخدم فيبدأ بحفظه محليًا.
 *
 * لا تسريب بيانات حسّاسة هنا (لا PIN ولا حتى قائمة الموظفين) — فقط
 * الحد الأدنى لتفعيل الجهاز: هوية الفرع نفسها، تمامًا كما لو قرأها أحد
 * من لافتة على باب الفرع.
 */
router.get("/branches/by-ref/:ref", async (req, res, next) => {
  try {
    // ⚠ deleted_at is null هنا عمدًا (migration 025_branches_soft_delete):
    // فرعٌ محذوف منطقيًّا يجب ألّا يُقرأ رابطه كأنه لا يزال حيًّا — جهازٌ
    // يفتح رابط فرعٍ حُذف بعد ربطه به يجب أن يرى "الفرع غير موجود" بالضبط
    // كأنه رمزٌ خاطئ من الأصل، لا أن يُربط به بصمت.
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, ref, name from branches where ref = $1 and deleted_at is null`,
        [req.params.ref]
      )
    );
    const branch = rows[0];
    if (!branch) return res.status(404).json({ error: "branch_not_found" });
    res.json({ branchId: branch.id, branchRef: branch.ref, branchName: branch.name });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/branches/:branchId/users
 * Public name/role picker for the login screen — matches the tap-a-name
 * step in the frontend's login flow. Never returns pin_hash.
 */
router.get("/branches/:branchId/users", async (req, res, next) => {
  try {
    // ⚠ نتحقق أولًا أن الفرع نفسه غير محذوف (لا فقط أن users.active) —
    // فرعٌ محذوف منطقيًّا يجب أن يُعامَل كأنه غير موجود من واجهة تسجيل
    // الدخول العلنية هذه، بصرف النظر عن حالة كل موظف فيه على حدة.
    const { rows: branchRows } = await withoutBranch((client) =>
      client.query(`select 1 from branches where id = $1 and deleted_at is null`, [req.params.branchId])
    );
    if (!branchRows.length) return res.status(404).json({ error: "branch_not_found" });

    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, name, ref, role from users
          where branch_id = $1 and active = true
          order by name`,
        [req.params.branchId]
      )
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login  { branchId, userId, pin }
 * Verifies the PIN against that specific user's bcrypt hash and issues a
 * JWT. Mirrors the frontend flow: pick branch -> tap a name -> enter PIN
 * -> that PIN is checked against THAT person's hash (not scanned against
 * everyone), which is also the only way bcrypt's random salting works.
 */
router.post("/auth/login", async (req, res, next) => {
  const { branchId, userId, pin } = req.body || {};
  if (!branchId || !userId || !pin) {
    return res.status(400).json({ error: "branchId, userId and pin are required" });
  }
  try {
    // ⚠ نفس مبدأ "لا نكشف أي جزءٍ من سبب الفشل" المتّبع في PriceLoginScreen:
    // فرعٌ محذوف يُعطي نفس invalid_credentials تمامًا مثل مستخدم/PIN
    // خاطئين — لا رسالة مختلفة تكشف أن السبب تحديدًا هو حذف الفرع.
    const { rows: branchRows } = await withoutBranch((client) =>
      client.query(`select 1 from branches where id = $1 and deleted_at is null`, [branchId])
    );
    if (!branchRows.length) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const { rows } = await withoutBranch((client) =>
      client.query(
        `select u.*, s.status as store_status, s.subscription_expires_at
           from users u
           join branches b on b.id = u.branch_id
           left join stores s on s.id = b.store_id
          where u.id = $1 and u.branch_id = $2 and u.active = true`,
        [userId, branchId]
      )
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const ok = await verifyPin(pin, user.pin_hash);
    if (!ok) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    // ⚠ بعد التحقق من الرقم السري لا قبله: من لا يعرف الرقم لا يعرف حالة
    // اشتراك المحل. ومن يعرفه يرى سببًا واضحًا بدل «رقم خاطئ» مضلِّل.
    const storeBlock = storeBlockReason(user);
    if (storeBlock) {
      return res.status(403).json({ error: storeBlock });
    }
    const token = signSession(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, role: user.role, branchId: user.branch_id },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 *
 * ⚠ إصلاح حقيقي: التوكن كان يُحفظ فعليًا (أولًا في sessionStorage ثم
 * localStorage) لكن التطبيق لم يكن يملك أي مسار "استعادة جلسة" عند أي
 * تحميل جديد للصفحة — currentUser في GoldInventoryApp.jsx هو React state
 * فقط (يبدأ null دائمًا)، ولا شيء كان يتحقق من توكن محفوظ عند الإقلاع
 * ليُعيد بناء الجلسة به. النتيجة: أي refresh كان يُظهر شاشة الدخول من
 * جديد رغم أن التوكن نفسه لم تنتهِ صلاحيته بعد (12 ساعة). هذا الـendpoint
 * يتحقق من توكن Authorization الموجود (عبر authenticate نفسه) ويرجّع
 * بيانات المستخدم بنفس شكل استجابة /auth/login تمامًا — الفرونت إند
 * يستخدمه عند الإقلاع لإعادة بناء الجلسة تلقائيًا بلا طلب PIN من جديد.
 */
router.get("/auth/me", authenticate, (req, res) => {
  res.json({
    user: {
      id: req.auth.userId,
      name: req.auth.user.name,
      role: req.auth.role,
      branchId: req.auth.branchId,
    },
  });
});

export default router;
