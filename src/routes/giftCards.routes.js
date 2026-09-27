import { Router } from "express";
import crypto from "crypto";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";
import { loadModules, modCfg, modOn } from "../domain/modules.js";

const router = Router();

/**
 * بطاقات الهدايا ونقاط الولاء (migration 052):
 *   GET  /gift-cards                      — البطاقات وأرصدة نقاط العملاء
 *   GET  /gift-cards/lookup/:code         — رصيد بطاقة (للدفع بها في الفاتورة)
 *   POST /gift-cards { amount, method: cash|network, customerId?, note }  — بيع بطاقة
 *   POST /gift-cards/:id/void             — إلغاء بطاقةٍ لم تُستعمل (يُردّ مبلغها نقدًا)
 *   POST /loyalty/redeem { customerId, points } — استبدال النقاط ببطاقة هدية
 */
const guard = [authenticate, requireAnyPage("giftCards", "sales")];
const genCode = () => `GC-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
const shape = (g) => ({
  id: g.id, code: g.code, initial: Number(g.initial_amount), balance: Number(g.balance), customerId: g.customer_id, customerName: g.customer_name || "",
  source: g.source, status: g.status, method: g.payment_method, note: g.note || "", createdAt: g.created_at,
});

router.get("/gift-cards", ...guard, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const mods = await loadModules(c, req.auth.branchId);
      const { rows } = await c.query(
        `select g.*, cu.name as customer_name from gift_cards g left join customers cu on cu.id = g.customer_id
          where g.branch_id = $1 order by g.created_at desc limit 300`, [req.auth.branchId]);
      const { rows: pts } = await c.query(
        `select l.customer_id, cu.name, sum(l.points)::int as points from loyalty_ledger l join customers cu on cu.id = l.customer_id
          where l.branch_id = $1 group by 1, 2 having sum(l.points) <> 0 order by 3 desc`, [req.auth.branchId]);
      return {
        giftCardsOn: modOn(mods, "giftCards"), loyaltyOn: modOn(mods, "loyalty"), loyalty: modCfg(mods, "loyalty"),
        cards: rows.map(shape), points: pts.map((p) => ({ customerId: p.customer_id, name: p.name, points: p.points })),
      };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.get("/gift-cards/lookup/:code", ...guard, async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      "select g.*, cu.name as customer_name from gift_cards g left join customers cu on cu.id = g.customer_id where g.branch_id = $1 and upper(g.code) = upper($2)",
      [req.auth.branchId, String(req.params.code).trim()])).rows);
    if (!rows[0]) return res.status(404).json({ error: "gift_card_not_found" });
    res.json({ card: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.post("/gift-cards", ...guard, async (req, res, next) => {
  const b = req.body || {};
  const amount = roundMoney(Number(b.amount) || 0);
  const method = b.method === "network" ? "network" : "cash";
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      if (!modOn(await loadModules(c, req.auth.branchId), "giftCards")) return { error: "module_off" };
      const day = await getOpenBusinessDay(c, req.auth.branchId);
      if (b.customerId) {
        const { rows } = await c.query("select 1 from customers where id = $1 and branch_id = $2", [b.customerId, req.auth.branchId]);
        if (!rows[0]) return { error: "customer_not_found" };
      }
      const { rows } = await c.query(
        `insert into gift_cards (branch_id, code, initial_amount, balance, customer_id, source, payment_method, note, created_by)
         values ($1,$2,$3,$3,$4,'sold',$5,$6,$7) returning *`,
        [req.auth.branchId, genCode(), amount, b.customerId || null, method, String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      const g = rows[0];
      await c.query("insert into gift_card_tx (card_id, kind, amount, created_by) values ($1,'issue',$2,$3)", [g.id, amount, req.auth.userId]);
      await c.query(
        `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,'daily',$3,'in',$4,'gift_card','gift_cards',$5,$6,$7)`,
        [req.auth.branchId, day?.id || null, method, amount, g.id, `بطاقة هدية ${g.code}`, req.auth.userId]);
      await postJournalEntry(c, { branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "gift_card_sell", refTable: "gift_cards", refId: g.id,
        description: `بيع بطاقة هدية ${g.code}`, createdBy: req.auth.userId,
        lines: [{ account: method === "network" ? "1140" : "1130", side: "debit", amount }, { account: "2260", side: "credit", amount }] });
      return { card: shape(g) };
    });
    if (result.error) return res.status(result.error === "module_off" ? 403 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/gift-cards/:id/void", ...guard, async (req, res, next) => {
  if (req.auth.role !== "manager") return res.status(403).json({ error: "forbidden" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query("select * from gift_cards where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const g = rows[0];
      if (!g) return { error: "gift_card_not_found" };
      if (g.status !== "active" || Number(g.balance) !== Number(g.initial_amount)) return { error: "gift_card_used" };
      const day = await getOpenBusinessDay(c, req.auth.branchId);
      const amount = Number(g.balance);
      if (g.source === "sold") {
        await c.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily',$3,'out',$4,'gift_card','gift_cards',$5,$6,$7)`,
          [req.auth.branchId, day?.id || null, g.payment_method || "cash", amount, g.id, `إلغاء بطاقة ${g.code}`, req.auth.userId]);
      }
      await postJournalEntry(c, { branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "gift_card_void", refTable: "gift_cards", refId: g.id,
        description: `إلغاء بطاقة هدية ${g.code}`, createdBy: req.auth.userId,
        lines: [{ account: "2260", side: "debit", amount },
          { account: g.source === "loyalty" ? "6950" : g.payment_method === "network" ? "1140" : "1130", side: "credit", amount }] });
      await c.query("update gift_cards set status = 'void', balance = 0 where id = $1", [g.id]);
      await c.query("insert into gift_card_tx (card_id, kind, amount, created_by) values ($1,'void',$2,$3)", [g.id, amount, req.auth.userId]);
      if (g.source === "loyalty") {
        const { rows: lr } = await c.query("select -points as p, customer_id from loyalty_ledger where gift_card_id = $1 limit 1", [g.id]);
        if (lr[0]) await c.query("insert into loyalty_ledger (branch_id, customer_id, points, gift_card_id, note, created_by) values ($1,$2,$3,$4,'إلغاء بطاقة — عادت النقاط',$5)",
          [req.auth.branchId, lr[0].customer_id, lr[0].p, g.id, req.auth.userId]);
      }
      return { ok: true };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/loyalty/redeem", ...guard, async (req, res, next) => {
  const customerId = req.body?.customerId;
  const points = Math.floor(Number(req.body?.points) || 0);
  if (!customerId || !(points > 0)) return res.status(400).json({ error: "invalid_points" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const mods = await loadModules(c, req.auth.branchId);
      if (!modOn(mods, "loyalty") || !modOn(mods, "giftCards")) return { error: "module_off" };
      const cfg = modCfg(mods, "loyalty");
      await c.query("select pg_advisory_xact_lock(hashtext($1))", [`loyalty:${customerId}`]);
      const { rows: bal } = await c.query("select coalesce(sum(points), 0)::int as p from loyalty_ledger where branch_id = $1 and customer_id = $2", [req.auth.branchId, customerId]);
      if (points > bal[0].p) return { error: "insufficient_points", available: bal[0].p };
      const amount = roundMoney(points * (Number(cfg.pointValue) || 0));
      if (!(amount > 0)) return { error: "point_value_zero" };
      const day = await getOpenBusinessDay(c, req.auth.branchId);
      const { rows } = await c.query(
        `insert into gift_cards (branch_id, code, initial_amount, balance, customer_id, source, note, created_by)
         values ($1,$2,$3,$3,$4,'loyalty',$5,$6) returning *`,
        [req.auth.branchId, genCode(), amount, customerId, `استبدال ${points} نقطة`, req.auth.userId]);
      const g = rows[0];
      await c.query("insert into gift_card_tx (card_id, kind, amount, created_by) values ($1,'issue',$2,$3)", [g.id, amount, req.auth.userId]);
      await c.query("insert into loyalty_ledger (branch_id, customer_id, points, gift_card_id, note, created_by) values ($1,$2,$3,$4,$5,$6)",
        [req.auth.branchId, customerId, -points, g.id, `استُبدلت ببطاقة ${g.code}`, req.auth.userId]);
      await postJournalEntry(c, { branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "loyalty_redeem", refTable: "gift_cards", refId: g.id,
        description: `استبدال ${points} نقطة ولاء ببطاقة ${g.code}`, createdBy: req.auth.userId,
        lines: [{ account: "6950", side: "debit", amount }, { account: "2260", side: "credit", amount }] });
      return { card: shape(g), pointsLeft: bal[0].p - points };
    });
    if (result.error) return res.status(result.error === "module_off" ? 403 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
