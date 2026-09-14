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

  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select u.*, r.allowed_tabs, r.allowed_more, r.deny_actions,
                r.can_manage_day, r.can_break
           from users u
           join roles r on r.id = u.role
          where u.id = $1 and u.branch_id = $2 and u.active = true`,
        [payload.sub, payload.branchId]
      )
    );
    const user = rows[0];
    if (!user) {
      return res.status(401).json({ error: "user_not_found_or_inactive" });
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

export {
  authenticate,
  requirePage,
  requireAnyPage,
  requireNotDenied,
  requireCanManageDay,
  requireCanBreak,
  requireManager,
};
