import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { roundWeight } from "../domain/weight.js";
import { loadModules, modOn } from "../domain/modules.js";
import { handleCreatePurchase } from "./purchases.routes.js";

const router = Router();
const KARATS = [24, 22, 21, 18, 14];
const guard = [authenticate, requireAnyPage("purchaseOrders", "purchases"), requireNotDenied("purchase")];

/**
 * أوامر الشراء (migration 057 · وحدة purchaseOrders):
 *   GET  /purchase-orders
 *   POST /purchase-orders { supplierId, lines:[{karat, weight, pieces, costPerGram}], expectedDate, note }
 *   POST /purchase-orders/:id/receive { paymentMethod, lines:[{karat, weight, costPerGram, workmanshipTotal}], officeId?, payFeesNow? }
 *        ← يُسجَّل شراءً فعليًّا بمعالج الشراء نفسه، ويُقفل الأمر بالمقارنة
 *   POST /purchase-orders/:id/cancel
 */
const shape = (o) => ({
  id: o.id, ref: o.ref, supplierId: o.supplier_id, supplierName: o.supplier_name || "", lines: o.lines || [], totalWeight: Number(o.total_weight),
  estTotal: Number(o.est_total), status: o.status, expectedDate: o.expected_date, note: o.note || "", purchaseId: o.purchase_id,
  receivedWeight: o.received_weight == null ? null : Number(o.received_weight), createdAt: o.created_at, closedAt: o.closed_at,
});

router.get("/purchase-orders", ...guard, async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select o.*, s.name as supplier_name from purchase_orders o join suppliers s on s.id = o.supplier_id
        where o.branch_id = $1 order by o.created_at desc limit 200`, [req.auth.branchId])).rows);
    res.json({ orders: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post("/purchase-orders", ...guard, async (req, res, next) => {
  const b = req.body || {};
  const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({
    karat: Number(l.karat), weight: roundWeight(Number(l.weight) || 0), pieces: Math.max(0, Math.round(Number(l.pieces) || 0)), costPerGram: roundMoney(Number(l.costPerGram) || 0),
  })).filter((l) => l.weight > 0);
  if (!b.supplierId) return res.status(400).json({ error: "supplier_required" });
  if (!lines.length || lines.some((l) => !KARATS.includes(l.karat))) return res.status(400).json({ error: "invalid_line" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      if (!modOn(await loadModules(c, req.auth.branchId), "purchaseOrders")) return { error: "module_off" };
      const { rows: sp } = await c.query("select name from suppliers where id = $1 and branch_id = $2", [b.supplierId, req.auth.branchId]);
      if (!sp[0]) return { error: "supplier_not_found" };
      const { rows: n } = await c.query("select count(*)::int + 1 as n from purchase_orders where branch_id = $1", [req.auth.branchId]);
      const { rows } = await c.query(
        `insert into purchase_orders (branch_id, ref, supplier_id, lines, total_weight, est_total, expected_date, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [req.auth.branchId, `PO-${String(n[0].n).padStart(5, "0")}`, b.supplierId, JSON.stringify(lines),
         roundWeight(lines.reduce((a, l) => a + l.weight, 0)), roundMoney(lines.reduce((a, l) => a + l.weight * l.costPerGram, 0)),
         b.expectedDate || null, String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      return { order: shape({ ...rows[0], supplier_name: sp[0].name }) };
    });
    if (result.error) return res.status(result.error === "module_off" ? 403 : result.error.endsWith("not_found") ? 404 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/purchase-orders/:id/receive", ...guard, async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query("select * from purchase_orders where id = $1 and branch_id = $2", [req.params.id, req.auth.branchId]));
    const o = rows[0];
    if (!o) return res.status(404).json({ error: "order_not_found" });
    if (o.status !== "open") return res.status(409).json({ error: `order_${o.status}` });
    const body = { ...(req.body || {}), supplierId: o.supplier_id, notes: `استلام أمر الشراء ${o.ref}${req.body?.notes ? ` · ${req.body.notes}` : ""}` };
    // معالج الشراء نفسه — بقيوده وتحقّقه كاملًا
    const r = await new Promise((resolve, reject) => {
      const res2 = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(x) { resolve({ status: this.statusCode, body: x }); return this; } };
      handleCreatePurchase({ auth: req.auth, body }, res2, (err) => (err ? reject(err) : resolve({ status: 500, body: { error: "internal_error" } })));
    });
    if (r.status >= 400) return res.status(r.status).json(r.body);
    const received = roundWeight(Number(r.body.purchase?.totalWeight) || 0);
    const { rows: up } = await withBranch(req.auth.branchId, (c) => c.query(
      "update purchase_orders set status = 'received', purchase_id = $2, received_weight = $3, closed_at = now() where id = $1 and status = 'open' returning *",
      [o.id, r.body.purchase.id, received]));
    res.status(201).json({ ...r.body, order: shape(up[0] || o), variance: roundWeight(received - Number(o.total_weight)) });
  } catch (err) {
    next(err);
  }
});

router.post("/purchase-orders/:id/cancel", ...guard, async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query(
      "update purchase_orders set status = 'cancelled', closed_at = now() where id = $1 and branch_id = $2 and status = 'open' returning *", [req.params.id, req.auth.branchId]));
    if (!rows[0]) return res.status(409).json({ error: "order_not_open" });
    res.json({ order: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

export default router;
