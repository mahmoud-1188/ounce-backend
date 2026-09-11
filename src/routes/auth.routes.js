import { Router } from "express";
import { withoutBranch } from "../db.js";
import { verifyPin } from "../auth/hashPin.js";
import { signSession } from "../auth/jwt.js";

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

export default router;
