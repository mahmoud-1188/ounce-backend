import { verifySession } from "../auth/jwt.js";
import { withoutBranch } from "../db.js";
import { currentAllowed } from "../auth/permissions.js";

/**
 * Verifies the bearer JWT, loads the user's role from the database (not
 * just what's in the token — a role change or deactivation must take
 * effect immediately, not after the token expires), and attaches
 * `req.auth = { userId, branchId, role, user, allowedPages }`.
 *
 * Every route below this middleware in the chain can trust req.auth
 * without re-checking the token.
 */
/**
 * سبب منع الدخول بسبب اشتراك المتجر، أو null إن كان سليمًا.
 * store_status = null (فرعٌ بلا متجر — بيانات قديمة) لا يُمنع.
 */
function storeBlockReason(row) {
  if (row.store_status && row.store_status !== "active") return `store_${row.store_status}`;
  if (row.subscription_expires_at && new Date(row.subscription_expires_at).getTime() < Date.now()) {
    return "subscription_expired";
  }
  return null;
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }

  // ⚠ رفض صريح لتوكن store_users (scope: "store" — راجع
  // storeAuth.js): بلاه كان payload.branchId المفقود سيجعل
  // الاستعلام أدناه يفشل بصمت "مستخدم غير موجود" بدل رفض
  // صريح لسبب الفشل الحقيقي (نوع توكن خاطئ).
  if (payload.scope && payload.scope !== "branch") {
    return res.status(401).json({ error: "wrong_token_scope" });
  }

  try {
    // ⚠ إضافة b.deleted_at is null هنا عمدًا (migration
    // 025_branches_soft_delete): بلا هذا الشرط، مديرٌ سجّل دخوله *قبل*
    // حذف فرعه يبقى قادرًا على استخدام كل شاشات التطبيق حتى انتهاء
    // صلاحية توكنه (12 ساعة) رغم أن الفرع "محذوف" من كل مكان آخر —
    // authenticate يعمل على كل طلبٍ لاحقٍ لكل مسار، لا فقط عند تسجيل
    // الدخول نفسه (راجع auth.routes.js لنفس الفحص هناك تحديدًا).
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select u.*, r.allowed_tabs, r.allowed_more, r.deny_actions,
                r.can_manage_day, r.can_break,
                s.status as store_status, s.subscription_expires_at
           from users u
           join branches b on b.id = u.branch_id
           join roles r on r.id = u.role
           left join stores s on s.id = b.store_id
          where u.id = $1 and u.branch_id = $2 and u.active = true and b.deleted_at is null`,
        [payload.sub, payload.branchId]
      )
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "user_not_found_or_inactive" });
    }
    // ⚠ اشتراك المتجر يُفرض على الفرع أيضًا لا على المركزي وحده (migration
    // 032 — لوحة الأدمن): قبل هذا، متجرٌ موقوف أو منتهي الاشتراك كان يُقفل
    // تطبيق المركزي فقط، بينما فروعه تواصل البيع والشراء كأن شيئًا لم يكن.
    // الفحص هنا على كل طلب، فالإيقاف يسري فورًا لا بعد انتهاء التوكن.
    const storeBlock = storeBlockReason(user);
    if (storeBlock) {
      return res.status(403).json({ error: storeBlock });
    }

    const role = {
      allowed_tabs: user.allowed_tabs,
      allowed_more: user.allowed_more,
      deny_actions: user.deny_actions,
      can_manage_day: user.can_manage_day,
      can_break: user.can_break,
    };

    req.auth = {
      userId: user.id,
      branchId: user.branch_id,
      role: user.role,
      user,
      roleConfig: role,
      allowedPages: currentAllowed(user, role),
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Refuses the request unless the caller's effective page list includes
 * `pageId` — the server-side mirror of a button the frontend would have
 * hidden. This is what actually stops the operation; the frontend hiding
 * the button is only a convenience.
 */
function requirePage(pageId) {
  return (req, res, next) => {
    if (!req.auth?.allowedPages?.includes(pageId)) {
      return res.status(403).json({ error: "page_not_allowed", page: pageId });
    }
    next();
  };
}

/**
 * Like requirePage, but passes if the caller has ANY of the listed pages —
 * for an action that legitimately belongs to more than one screen (e.g.
 * binding an RFID tag to a unit: done from "التكويد" at intake, but also
 * from stocktake/sales-return when an unknown tag turns up mid-scan, per
 * the reference's RfidReaderPage/BindEpcSheet, which has no page guard of
 * its own beyond whatever screen it's opened from).
 */
function requireAnyPage(...pageIds) {
  return (req, res, next) => {
    const allowed = req.auth?.allowedPages || [];
    if (!pageIds.some((p) => allowed.includes(p))) {
      return res.status(403).json({ error: "page_not_allowed", pages: pageIds });
    }
    next();
  };
}

/**
 * Refuses the request if `actionId` is in the caller's role's
 * `deny_actions` — the server-side mirror of ROLES[role].denyActions in
 * constants.js. Comment there is explicit: "ما لا يُسمح به صراحةً يُمنع،
 * والقائمة أدناه تُقرأ في المعالجات لا في الشاشات وحدها" (read in the
 * handlers, not just the screens) — this middleware is that handler-side
 * enforcement.
 */
function requireNotDenied(actionId) {
  return (req, res, next) => {
    if (req.auth?.roleConfig?.deny_actions?.includes(actionId)) {
      return res.status(403).json({ error: "action_denied_for_role", action: actionId });
    }
    next();
  };
}

/** Refuses unless the caller's role can open/close a business day. */
function requireCanManageDay(req, res, next) {
  if (!req.auth?.roleConfig?.can_manage_day) {
    return res.status(403).json({ error: "cannot_manage_day" });
  }
  next();
}

/**
 * Refuses unless the caller's role can break stones off scrap
 * (`ROLES[role].canBreak` in constants.js — مسؤول الكسر تحديدًا).
 * Mirrors handleBreakStones' `if (!ROLES[role]?.canBreak)` guard.
 */
function requireCanBreak(req, res, next) {
  if (!req.auth?.roleConfig?.can_break) {
    return res.status(403).json({ error: "cannot_break_stones" });
  }
  next();
}

/**
 * Refuses unless the caller's role is literally "manager" — stricter than
 * `requireCanManageDay` (which `assistant` also satisfies). Mirrors
 * `SafeAuditPage`'s `canManage={role === "manager"}` prop in the reference:
 * that screen intentionally restricts to the manager role specifically,
 * unlike day-open/close which `assistant` may also do.
 */
function requireManager(req, res, next) {
  if (req.auth?.role !== "manager") {
    return res.status(403).json({ error: "manager_only" });
  }
  next();
}

export { storeBlockReason,
  authenticate,
  requirePage,
  requireAnyPage,
  requireNotDenied,
  requireCanManageDay,
  requireCanBreak,
  requireManager,
};
