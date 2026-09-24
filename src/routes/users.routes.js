import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import {
  loadBranchUsersWithRoles,
  createBranchUser,
  renameBranchUser,
  setBranchUserAi,
  setBranchUserPermissions,
  removeBranchUser,
} from "../domain/branchUsers.js";

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

// ⚠ منطق كل مسارٍ هنا مُستخرَج الآن إلى src/domain/branchUsers.js
// (نفس السلوك حرفيًّا) ليشترك فيه هذا الملف ومسارات الفروع عن بعد في
// store.routes.js — راجع كومنت أعلى ذلك الملف للسبب الكامل.

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
    const result = await withBranch(req.auth.branchId, (client) =>
      createBranchUser(client, req.auth.branchId, { name, pin, role, salary }, { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" })
    );
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
    const result = await withBranch(req.auth.branchId, (client) =>
      renameBranchUser(client, req.auth.branchId, req.params.id, name, { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" })
    );
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
    const result = await withBranch(req.auth.branchId, (client) =>
      setBranchUserAi(client, req.auth.branchId, req.params.id, req.body?.canUseAi, { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    res.json(result.user);
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
    const result = await withBranch(req.auth.branchId, (client) =>
      setBranchUserPermissions(client, req.auth.branchId, req.params.id, allowedPages, { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" })
    );
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
    const result = await withBranch(req.auth.branchId, (client) =>
      removeBranchUser(client, req.auth.branchId, req.params.id, { id: req.auth.userId, name: req.auth.user?.name, kind: "branch" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
