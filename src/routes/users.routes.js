import { Router } from "express";
import { withBranch } from "../db.js";
import { hashPin, verifyPin } from "../auth/hashPin.js";
import { normalizeName } from "../auth/normalizeName.js";
import { currentAllowed, wouldLockOutAccess, wouldRemoveLastManager } from "../auth/permissions.js";
import { authenticate, requirePage } from "../middleware/auth.js";

const router = Router();

// Every route here mirrors a control on AccessSettingsPage.jsx, and every
// route requires the "access" page — exactly like the frontend hides the
// whole screen from anyone without it, except here it's actually enforced.
//
// ⚠ لازم تحديد المسار "/users" صراحةً هنا. router.use(authenticate,...)
// بدون مسار كانت تطبّق بوابة "access" هذي على أي طلب /api/* يمرّ عليها —
// بما فيها /api/sales و/api/purchases — قبل ما يصل أصلًا لبوابة الصلاحية
// الصحيحة في الـrouter المقصود. كل ملفات routes مركّبة بنفس البادئة
// app.use("/api", ...)، فتحديد المسار هنا إلزامي لعزل كل بوابة بمسارها.
router.use("/users", authenticate, requirePage("access"));

async function loadBranchUsersWithRoles(client, branchId) {
  const { rows } = await client.query(
    `select u.*, r.allowed_tabs, r.allowed_more
       from users u join roles r on r.id = u.role
      where u.branch_id = $1 and u.active = true`,
    [branchId]
  );
  return rows.map((u) => ({
    ...u,
    allowed: currentAllowed(u, { allowed_tabs: u.allowed_tabs, allowed_more: u.allowed_more }),
  }));
}

/** GET /api/users — list, PIN and internal role-config columns excluded. */
router.get("/users", async (req, res, next) => {
  try {
    const users = await withBranch(req.auth.branchId, (client) =>
      loadBranchUsersWithRoles(client, req.auth.branchId)
    );
    res.json(
      users.map(({ id, name, ref, role, salary, can_use_ai, allowed_pages, allowed, active, created_at }) => ({
        id, name, ref, role, salary, can_use_ai, allowed_pages, allowed, active, created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users  { name, pin, role, salary }
 * Mirrors AccessSettingsPage.jsx `add()` + its `valid` guard: name
 * required, PIN 4-6 digits, name not taken (normalizeName), PIN not
 * already used by anyone in the branch.
 */
router.post("/users", async (req, res, next) => {
  const { name, pin, role, salary } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  if (!/^\d{4,6}$/.test(String(pin || ""))) {
    return res.status(400).json({ error: "pin_must_be_4_to_6_digits" });
  }
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const roleId = role || "employee";
      const { rows: roleRows } = await client.query(
        "select 1 from roles where id = $1",
        [roleId]
      );
      if (!roleRows[0]) return { error: "invalid_role" };

      const existing = await loadBranchUsersWithRoles(client, req.auth.branchId);

      const nameTaken = existing.some(
        (u) => normalizeName(u.name) === normalizeName(name)
      );
      if (nameTaken) return { error: "name_taken" };

      // bcrypt hashes are salted per-row, so "is this PIN already used"
      // can't be a SQL index lookup — we compare against every existing
      // hash in the branch, same as the frontend's `pinTaken` loop.
      for (const u of existing) {
        if (await verifyPin(pin, u.pin_hash)) return { error: "pin_taken" };
      }

      const pinHash = await hashPin(pin);
      const { rows } = await client.query(
        `insert into users (branch_id, name, role, pin_hash, salary)
         values ($1, $2, $3, $4, $5)
         returning id, name, role, salary, created_at`,
        [req.auth.branchId, name.trim(), roleId, pinHash, Number(salary) || 0]
      );
      return { user: rows[0] };
    });

    if (result.error === "invalid_role") return res.status(400).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(201).json(result.user);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/users/:id/rename  { name } */
router.patch("/users/:id/rename", async (req, res, next) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const existing = await loadBranchUsersWithRoles(client, req.auth.branchId);
      const nameTaken = existing.some(
        (u) => u.id !== req.params.id && normalizeName(u.name) === normalizeName(name)
      );
      if (nameTaken) return { error: "name_taken" };
      const { rows } = await client.query(
        `update users set name = $1 where id = $2 and branch_id = $3 returning id, name`,
        [name.trim(), req.params.id, req.auth.branchId]
      );
      if (!rows[0]) return { error: "not_found" };
      return { user: rows[0] };
    });
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result.user);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/users/:id/ai  { canUseAi: boolean } — toggleAi() in the frontend. */
router.patch("/users/:id/ai", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query(
        `update users set can_use_ai = $1 where id = $2 and branch_id = $3
         returning id, can_use_ai`,
        [!!req.body?.canUseAi, req.params.id, req.auth.branchId]
      )
    );
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/users/:id/permissions  { allowedPages: string[] | null }
 * `null` resets to the role's defaults (resetToRole()). An array sets an
 * explicit override (togglePage()) — including the guard that refuses to
 * strip "access" from the last person who holds it.
 */
router.patch("/users/:id/permissions", async (req, res, next) => {
  const { allowedPages } = req.body || {};
  if (allowedPages !== null && !Array.isArray(allowedPages)) {
    return res.status(400).json({ error: "allowedPages_must_be_array_or_null" });
  }
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const existing = await loadBranchUsersWithRoles(client, req.auth.branchId);
      const target = existing.find((u) => u.id === req.params.id);
      if (!target) return { error: "not_found" };

      if (allowedPages !== null) {
        const nextForOthers = existing; // guard compares against everyone else's CURRENT allowed pages
        if (wouldLockOutAccess(nextForOthers, target.id, allowedPages)) {
          return {
            error: "would_lock_out_access",
            message:
              "لا يمكن إزالة «صلاحيات الوصول» من آخر مستخدم يملكها — سيتعذّر تعديل أي صلاحية بعدها.",
          };
        }
      }

      const { rows } = await client.query(
        `update users set allowed_pages = $1 where id = $2 and branch_id = $3
         returning id, allowed_pages`,
        [allowedPages === null ? null : JSON.stringify(allowedPages), req.params.id, req.auth.branchId]
      );
      return { user: rows[0] };
    });
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json(result);
    res.json(result.user);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/users/:id
 * Mirrors remove(): refuses to delete the last manager in the branch.
 * (The frontend also refuses when there's only one user left at all —
 * that's a UI convenience for a single-employee shop, not a safety rule,
 * so it is intentionally NOT replicated here as a hard block.)
 */
router.delete("/users/:id", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const existing = await loadBranchUsersWithRoles(client, req.auth.branchId);
      if (wouldRemoveLastManager(existing, req.params.id)) {
        return { error: "would_remove_last_manager" };
      }
      const { rowCount } = await client.query(
        `update users set active = false where id = $1 and branch_id = $2`,
        [req.params.id, req.auth.branchId]
      );
      if (!rowCount) return { error: "not_found" };
      return { ok: true };
    });
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
