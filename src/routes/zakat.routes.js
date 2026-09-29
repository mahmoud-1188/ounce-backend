import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { computeZakat, zakatInputs } from "../domain/zakat.js";

const router = Router();

/**
 * GET /api/zakat?asOf=YYYY-MM-DD&price24=…
 * الزكاة من دفاتر الفرع كاملةً بطريقةٍ واحدة (المرجع 5.2.0). مطفأةً في
 * الإعدادات: { on: false } بلا حساب — فلا بطاقة ولا إيضاح.
 */
router.get("/zakat", authenticate, requireAnyPage("financials", "reportsHub", "fullStatements", "ifrs"), async (req, res, next) => {
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asOf || "")) ? String(req.query.asOf) : null;
  const price24 = Number(req.query.price24) || 0;
  try {
    const out = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select zakat_enabled, zakat_year from branch_settings where branch_id = $1", [req.auth.branchId]);
      const on = rows[0] ? rows[0].zakat_enabled !== false : true;
      const year = rows[0]?.zakat_year === "hijri" ? "hijri" : "gregorian";
      if (!on) return { on: false, year };
      const inputs = await zakatInputs(client, req.auth.branchId, asOf);
      return { on: true, ...computeZakat(inputs, { price24, year }) };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
