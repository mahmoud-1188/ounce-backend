import { Router } from "express";
import { withoutBranch } from "../db.js";
import { verifyPin } from "../auth/hashPin.js";
import { signSession } from "../auth/jwt.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

/**
 * GET /api/branches/:branchId/users
 * Public name/role picker for the login screen — matches the tap-a-name
 * step in the frontend's login flow. Never returns pin_hash.
 */
router.get("/branches/:branchId/users", async (req, res, next) => {
  try {
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
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select * from users where id = $1 and branch_id = $2 and active = true`,
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
