import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";
import { loadModules, modOn } from "../domain/modules.js";

const router = Router();
const guard = [authenticate, requireAnyPage("customOrders", "sales")];
const STAGES = ["received", "design", "workshop", "ready", "delivered", "cancelled"];
const KARATS = [24, 22, 21, 18, 14];

/**
 * الطلبات الخاصة (migration 059 · وحدة customOrders):
 *   GET  /custom-orders
 *   POST /custom-orders { customerId, description, karat, estWeight, estPrice, deposit, depositMethod: cash|network, dueDate, note }
 *   POST /custom-orders/:id/stage { stage: design|workshop|ready, note }
 *   POST /custom-orders/:id/cancel { refund: true }   — يُردّ الباقي من العربون نقدًا
 * التسليم: فاتورة بيعٍ عادية مع customOrderId — يُخصم فيها العربون (2210) ويُقفل الطلب «سُلّم».
 */
const shape = (o) => ({
  id: o.id, ref: o.ref, customerId: o.customer_id, customerName: o.customer_name || "", description: o.description, karat: o.karat,
  estWeight: o.est_weight == null ? null : Number(o.est_weight), estPrice: o.est_price == null ? null : Number(o.est_price),
  deposit: Number(o.deposit), depositUsed: Number(o.deposit_used), depositLeft: roundMoney(Number(o.deposit) - Number(o.deposit_used)),
  depositMethod: o.deposit_method, dueDate: o.due_date, stage: o.stage, stageLog: o.stage_log || [], saleId: o.sale_id, note: o.note || "", createdAt: o.created_at,
});

router.get("/custom-orders", ...guard, async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select o.*, cu.name as customer_name from custom_orders o join customers cu on cu.id = o.customer_id
        where o.branch_id = $1 order by (o.stage in ('delivered','cancelled')), o.due_date nulls last, o.created_at desc limit 300`, [req.auth.branchId])).rows);
    res.json({ orders: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post("/custom-orders", ...guard, async (req, res, next) => {
  const b = req.body || {};
  const description = String(b.description || "").trim().slice(0, 300);
  const deposit = roundMoney(Number(b.deposit) || 0);
  const method = b.depositMethod === "network" ? "network" : "cash";
  if (!b.customerId) return res.status(400).json({ error: "customer_required" });
  if (!description) return res.status(400).json({ error: "description_required" });
  if (b.karat != null && b.karat !== "" && !KARATS.includes(Number(b.karat))) return res.status(400).json({ error: "invalid_karat" });
  if (deposit < 0) return res.status(400).json({ error: "invalid_amount" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      if (!modOn(await loadModules(c, req.auth.branchId), "customOrders")) return { error: "module_off" };
      const { rows: cu } = await c.query("select name from customers where id = $1 and branch_id = $2", [b.customerId, req.auth.branchId]);
      if (!cu[0]) return { error: "customer_not_found" };
      const day = await getOpenBusinessDay(c, req.auth.branchId);
      const { rows: n } = await c.query("select count(*)::int + 1 as n from custom_orders where branch_id = $1", [req.auth.branchId]);
      const log = [{ stage: "received", at: new Date().toISOString(), by: req.auth.user.name }];
      const { rows } = await c.query(
        `insert into custom_orders (branch_id, ref, customer_id, description, karat, est_weight, est_price, deposit, deposit_method, due_date, stage_log, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [req.auth.branchId, `ORD-${String(n[0].n).padStart(5, "0")}`, b.customerId, description, b.karat ? Number(b.karat) : null,
         Number(b.estWeight) || null, Number(b.estPrice) || null, deposit, deposit > 0 ? method : null, b.dueDate || null, JSON.stringify(log),
         String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      const o = rows[0];
      if (deposit > 0) {
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily',$3,'in',$4,'customer_deposit','custom_orders',$5,$6,$7)`,
          [req.auth.branchId, day?.id || null, method, deposit, o.id, `عربون ${o.ref}`, req.auth.userId]);
        await postJournalEntry(c, { branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "custom_order_deposit", refTable: "custom_orders", refId: o.id,
          description: `عربون طلبٍ خاص ${o.ref} — ${cu[0].name}`, createdBy: req.auth.userId,
          lines: [{ account: method === "network" ? "1140" : "1130", side: "debit", amount: deposit }, { account: "2210", side: "credit", amount: deposit }] });
      }
      return { order: shape({ ...o, customer_name: cu[0].name }) };
    });
    if (result.error) return res.status(result.error === "module_off" ? 403 : result.error.endsWith("not_found") ? 404 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/custom-orders/:id/stage", ...guard, async (req, res, next) => {
  const stage = req.body?.stage;
  if (!["design", "workshop", "ready"].includes(stage)) return res.status(400).json({ error: "invalid_stage" });
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `update custom_orders set stage = $3, stage_log = stage_log || $4::jsonb
        where id = $1 and branch_id = $2 and stage not in ('delivered','cancelled') returning *`,
      [req.params.id, req.auth.branchId, stage, JSON.stringify([{ stage, at: new Date().toISOString(), by: req.auth.user.name, note: String(req.body?.note || "").slice(0, 120) }])])).rows);
    if (!rows[0]) return res.status(409).json({ error: "order_closed" });
    res.json({ order: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post("/custom-orders/:id/cancel", ...guard, async (req, res, next) => {
  if (!["manager", "assistant"].includes(req.auth.role)) return res.status(403).json({ error: "forbidden" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query("select * from custom_orders where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const o = rows[0];
      if (!o) return { error: "order_not_found" };
      if (["delivered", "cancelled"].includes(o.stage)) return { error: "order_closed" };
      const left = roundMoney(Number(o.deposit) - Number(o.deposit_used));
      const day = await getOpenBusinessDay(c, req.auth.branchId);
      if (left > 0 && req.body?.refund !== false) {
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily',$3,'out',$4,'customer_deposit','custom_orders',$5,$6,$7)`,
          [req.auth.branchId, day?.id || null, o.deposit_method || "cash", left, o.id, `ردّ عربون ${o.ref}`, req.auth.userId]);
        await postJournalEntry(c, { branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "custom_order_refund", refTable: "custom_orders", refId: o.id,
          description: `ردّ عربون طلبٍ خاص ${o.ref}`, createdBy: req.auth.userId,
          lines: [{ account: "2210", side: "debit", amount: left }, { account: o.deposit_method === "network" ? "1140" : "1130", side: "credit", amount: left }] });
      }
      const { rows: up } = await c.query(
        `update custom_orders set stage = 'cancelled', deposit_used = deposit, stage_log = stage_log || $2::jsonb where id = $1 returning *`,
        [o.id, JSON.stringify([{ stage: "cancelled", at: new Date().toISOString(), by: req.auth.user.name, refunded: left }])]);
      return { order: shape(up[0]), refunded: left };
    });
    if (result.error) return res.status(result.error === "order_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
