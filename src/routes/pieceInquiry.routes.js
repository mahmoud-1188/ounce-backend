import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { buildPieceInquiry } from "../domain/pieceInquiry.js";

const router = Router();

// من يرى التكلفة: المدير ونائبه والمحاسب (المرجع: «التكلفة للمدير ونائبه والمحاسب»)
const COST_ROLES = new Set(["manager", "assistant", "accountant"]);

/** POST /api/piece-inquiry { codes: [...] } — بطاقة لكل رمز، قراءةٌ فقط. */
router.post("/piece-inquiry", authenticate, requireAnyPage("pieceInquiry", "inventory"), async (req, res, next) => {
  const codes = Array.isArray(req.body?.codes) ? req.body.codes : String(req.body?.codes || "").split(/[\s,،;]+/);
  try {
    const cards = await withBranch(req.auth.branchId, (c) =>
      buildPieceInquiry(c, req.auth.branchId, codes, { showCost: COST_ROLES.has(req.auth.role) })
    );
    res.json({ cards });
  } catch (err) {
    next(err);
  }
});

export default router;
