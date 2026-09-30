import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { ifrsBridge, ifrsMeasurement } from "../domain/ifrsBridge.js";

const router = Router();
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
// ⚠ «إلى» يشمل يومه كلّه، و«من» يبدأ من أوّله
const endOf = (d) => (d ? `${d}T23:59:59.999Z` : null);
const startOf = (d) => (d ? `${d}T00:00:00.000Z` : null);

/** GET /api/ifrs/bridge?from&to&priceOpen&priceClose — الجسر بين مقياس الإدارة (الوزن) والنتيجة الدولية. */
router.get("/ifrs/bridge", authenticate, requireAnyPage("ifrs", "fullStatements"), async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, (client) => ifrsBridge(client, req.auth.branchId, {
      from: startOf(day(req.query.from)), to: endOf(day(req.query.to)),
      priceOpen: Number(req.query.priceOpen) || 0, priceClose: Number(req.query.priceClose) || 0,
    }));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

/** GET /api/ifrs/measurement?asOf&price24 — قياس نهاية الفترة (IAS 2). عرضٌ بلا قيد. */
router.get("/ifrs/measurement", authenticate, requireAnyPage("ifrs", "fullStatements"), async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, (client) => ifrsMeasurement(client, req.auth.branchId, {
      asOf: endOf(day(req.query.asOf)), price24: Number(req.query.price24) || 0,
    }));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
