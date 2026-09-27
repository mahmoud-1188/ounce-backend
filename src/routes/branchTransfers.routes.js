import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { isStocktakeLocked, getOpenBusinessDay } from "../domain/saleOps.js";
import { loadModules, modOn } from "../domain/modules.js";

const router = Router();

/**
 * التحويل بين الفروع (migration 051 · وحدة branchTransfer):
 *   GET  /branch-transfers                 — الوارد والصادر، وفروع المتجر للاختيار
 *   POST /branch-transfers { toBranchId, codes, note }  — المرسِل: القطع تخرج من الرفّ «في الطريق»
 *   POST /branch-transfers/:id/receive     — المستلم: القطعة نفسها تنتقل لمخزونه برمزها
 *   POST /branch-transfers/:id/cancel      — المرسِل قبل الاستلام: تعود القطع
 * ⚠ القيود على الطرفين بتكلفة القطع — ويتقابل 1350 (المرسِل) و2140 (المستلم) في الموحّد.
 */
const MOVERS = new Set(["manager", "assistant"]);
const unitKey = (c) => String(c || "").trim().toUpperCase();
const useBranch = (c, id) => c.query("select set_config('app.current_branch_id', $1, true)", [id]);

function shape(t, me) {
  return {
    id: t.id, ref: t.ref, status: t.status, direction: t.from_branch_id === me ? "out" : "in",
    fromBranchId: t.from_branch_id, fromName: t.from_name || "", toBranchId: t.to_branch_id, toName: t.to_name || "",
    lines: t.lines || [], pieces: t.pieces, totalWeight: Number(t.total_weight), totalFine: Number(t.total_fine), totalCost: Number(t.total_cost),
    note: t.note || "", sentBy: t.sent_by_name || "", sentAt: t.sent_at, receivedBy: t.received_by_name || "", receivedAt: t.received_at, cancelledAt: t.cancelled_at,
  };
}

router.get("/branch-transfers", authenticate, requireAnyPage("branchTransfers", "inventory"), async (req, res, next) => {
  try {
    const me = req.auth.branchId;
    const out = await withoutBranch(async (c) => {
      const { rows: br } = await c.query(
        `select b.id, b.name, b.ref from branches b
          where b.store_id = (select store_id from branches where id = $1) and b.id <> $1 and b.deleted_at is null order by b.name`, [me]);
      const { rows } = await c.query(
        `select t.*, fb.name as from_name, tb.name as to_name from branch_transfers t
           join branches fb on fb.id = t.from_branch_id join branches tb on tb.id = t.to_branch_id
          where t.from_branch_id = $1 or t.to_branch_id = $1 order by t.sent_at desc limit 200`, [me]);
      return { branches: br, transfers: rows.map((t) => shape(t, me)) };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.post("/branch-transfers", authenticate, requireAnyPage("branchTransfers", "inventory"), async (req, res, next) => {
  if (!MOVERS.has(req.auth.role)) return res.status(403).json({ error: "forbidden" });
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : String(req.body?.codes || "").split(/[\s,،;]+/)).map(unitKey).filter(Boolean))];
  const toBranchId = req.body?.toBranchId;
  const note = String(req.body?.note || "").trim().slice(0, 200);
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  if (!toBranchId || toBranchId === req.auth.branchId) return res.status(400).json({ error: "invalid_target_branch" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const me = req.auth.branchId;
      if (!modOn(await loadModules(c, me), "branchTransfer")) return { error: "module_off" };
      if (await isStocktakeLocked(c, me)) return { error: "stocktake_locked" };
      const { rows: tb } = await c.query(
        `select b.id, b.name, b.store_id from branches b join branches me on me.store_id = b.store_id
          where b.id = $1 and me.id = $2 and b.deleted_at is null`, [toBranchId, me]);
      if (!tb[0]) return { error: "invalid_target_branch" };
      const { rows } = await c.query(
        `select u.id, u.code, u.sold, u.issued, u.held, i.id as item_id, i.ref as item_ref, i.karat, i.weight, i.stones_weight,
                coalesce(i.cost_per_gram, 0) as cpg, coalesce(i.workmanship, 0) as wm, i.reserved_for, i.photo_url, c.name as category, c.sale_mode
           from item_units u join items i on i.id = u.item_id join categories c on c.id = i.category_id
          where i.branch_id = $1 and upper(u.code) = any($2::text[]) for update of u`, [me, codes]);
      const by = new Map(rows.map((r) => [unitKey(r.code), r]));
      const errors = [];
      for (const k of codes) {
        const u = by.get(k);
        if (!u) errors.push(`الرمز ${k} ليس في مخزون الفرع`);
        else if (u.sold) errors.push(`الرمز ${k} مباع`);
        else if (u.issued) errors.push(`الرمز ${k} خارج المخزون`);
        else if (u.held) errors.push(`الرمز ${k} معلّق من الوضع الخفي`);
        else if (u.reserved_for) errors.push(`الرمز ${k} محجوزٌ لعميل`);
        else if (u.sale_mode === "partial") errors.push(`الرمز ${k} من صنفٍ يُباع بالوزن — لا يُحوَّل قطعةً`);
      }
      if (errors.length) return { error: "transfer_rejected", errors };
      const lines = rows.map((r) => ({
        unitId: r.id, code: r.code, itemId: r.item_id, itemRef: r.item_ref, karat: r.karat, weight: Number(r.weight),
        stonesWeight: Number(r.stones_weight || 0), costPerGram: Number(r.cpg), workmanship: Number(r.wm), category: r.category,
        photoUrl: r.photo_url || null, cost: roundMoney(Number(r.cpg) * Number(r.weight) + Number(r.wm)),
      }));
      const totalWeight = roundWeight(lines.reduce((a, l) => a + l.weight, 0));
      const totalFine = roundWeight(lines.reduce((a, l) => a + fineWeight(l.weight, l.karat), 0));
      const totalCost = roundMoney(lines.reduce((a, l) => a + l.cost, 0));
      const { rows: n } = await c.query("select count(*)::int + 1 as n from branch_transfers where from_branch_id = $1", [me]);
      const { rows: br } = await c.query("select ref from branches where id = $1", [me]);
      const ref = `TRF-${br[0]?.ref || "BR"}-${String(n[0].n).padStart(4, "0")}`;
      const { rows: ins } = await c.query(
        `insert into branch_transfers (ref, store_id, from_branch_id, to_branch_id, lines, pieces, total_weight, total_fine, total_cost, note, sent_by, sent_by_name)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [ref, tb[0].store_id, me, toBranchId, JSON.stringify(lines), lines.length, totalWeight, totalFine, totalCost, note || null, req.auth.userId, req.auth.user.name]
      );
      const t = ins[0];
      await c.query("update item_units set issued = true, issued_at = now(), issued_by = $2, transfer_id = $3 where id = any($1::uuid[])",
        [lines.map((l) => l.unitId), req.auth.userId, t.id]);
      const day = await getOpenBusinessDay(c, me);
      for (const l of lines) {
        await c.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'branch_transfer_out',$3,$4,$5,'1210','1350','branch_transfers',$6,$7,$8)`,
          [me, day?.id || null, l.karat, l.weight, fineWeight(l.weight, l.karat), t.id, `${ref} ${l.code} ← ${tb[0].name}`, req.auth.userId]);
      }
      if (totalCost > 0) {
        await postJournalEntry(c, { branchId: me, businessDayId: day?.id || null, opType: "branch_transfer_out", refTable: "branch_transfers", refId: t.id,
          description: `تحويل ${lines.length} قطعة إلى ${tb[0].name} — ${ref}`, createdBy: req.auth.userId,
          lines: [{ account: "1350", side: "debit", amount: totalCost }, { account: "5110", side: "credit", amount: totalCost }] });
      }
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',$2,'branch_transfers',$3,$4)`,
        [me, req.auth.userId, t.id, JSON.stringify({ ref, to: tb[0].name, pieces: lines.length, totalWeight, totalCost })]);
      return { transfer: shape({ ...t, from_name: "", to_name: tb[0].name }, me) };
    });
    if (result.error) return res.status(result.error === "module_off" ? 403 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/branch-transfers/:id/receive", authenticate, requireAnyPage("branchTransfers", "inventory"), async (req, res, next) => {
  if (!MOVERS.has(req.auth.role)) return res.status(403).json({ error: "forbidden" });
  try {
    const me = req.auth.branchId;
    const result = await withBranch(me, async (c) => {
      const { rows } = await c.query("select * from branch_transfers where id = $1 and to_branch_id = $2 for update", [req.params.id, me]);
      const t = rows[0];
      if (!t) return { error: "transfer_not_found" };
      if (t.status !== "sent") return { error: `transfer_${t.status}` };
      const day = await getOpenBusinessDay(c, me);
      const { rows: fb } = await c.query("select name from branches where id = $1", [t.from_branch_id]);
      // تصنيفات المستلم بالاسم — ويُنشأ ما لا مثيل له
      const catOf = new Map();
      const groups = new Map();
      for (const l of t.lines) {
        const k = `${l.itemId}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(l);
      }
      const newItemIds = [];
      for (const [, ls] of groups) {
        const l0 = ls[0];
        if (!catOf.has(l0.category)) {
          const { rows: cr } = await c.query("select id from categories where (branch_id = $1 or branch_id is null) and name = $2 order by branch_id nulls last limit 1", [me, l0.category]);
          let cid = cr[0]?.id;
          if (!cid) {
            const { rows: src } = await c.query("select sale_mode from categories where id = (select category_id from items where id = $1)", [l0.itemId]).catch(() => ({ rows: [] }));
            const { rows: nc } = await c.query("insert into categories (branch_id, name, sale_mode) values ($1,$2,$3) returning id", [me, l0.category, src[0]?.sale_mode || "whole"]);
            cid = nc[0].id;
          }
          catOf.set(l0.category, cid);
        }
        const { rows: it } = await c.query(
          `insert into items (branch_id, ref, category_id, karat, weight, stones_weight, cost_per_gram, workmanship, photo_url, created_by, business_day_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
          [me, `${l0.itemRef}-${t.ref.split("-").pop()}`, catOf.get(l0.category), l0.karat, l0.weight, l0.stonesWeight || 0, l0.costPerGram, l0.workmanship,
           l0.photoUrl, req.auth.userId, day?.id || null]);
        newItemIds.push(it[0].id);
        await useBranch(c, t.from_branch_id);
        await c.query("update item_units set item_id = $1, issued = false, issued_at = null, issued_by = null where id = any($2::uuid[]) and transfer_id = $3",
          [it[0].id, ls.map((x) => x.unitId), t.id]);
        await useBranch(c, me);
        for (const l of ls) {
          await c.query(
            `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,'branch_transfer_in',$3,$4,$5,null,'1210','branch_transfers',$6,$7,$8)`,
            [me, day?.id || null, l.karat, l.weight, fineWeight(l.weight, l.karat), t.id, `${t.ref} ${l.code} ← من ${fb[0]?.name || ""}`, req.auth.userId]);
        }
      }
      const cost = Number(t.total_cost);
      if (cost > 0) {
        await postJournalEntry(c, { branchId: me, businessDayId: day?.id || null, opType: "branch_transfer_in", refTable: "branch_transfers", refId: t.id,
          description: `استلام ${t.pieces} قطعة من ${fb[0]?.name || ""} — ${t.ref}`, createdBy: req.auth.userId,
          lines: [{ account: "5110", side: "debit", amount: cost }, { account: "2140", side: "credit", amount: cost }] });
      }
      const { rows: up } = await c.query(
        "update branch_transfers set status = 'received', received_by = $2, received_by_name = $3, received_at = now() where id = $1 returning *",
        [t.id, req.auth.userId, req.auth.user.name]);
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'branch_transfers',$3,$4)`,
        [me, req.auth.userId, t.id, JSON.stringify({ received: t.ref, pieces: t.pieces })]);
      return { transfer: shape({ ...up[0], from_name: fb[0]?.name }, me), itemIds: newItemIds };
    });
    if (result.error) return res.status(result.error === "transfer_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/branch-transfers/:id/cancel", authenticate, requireAnyPage("branchTransfers", "inventory"), async (req, res, next) => {
  if (!MOVERS.has(req.auth.role)) return res.status(403).json({ error: "forbidden" });
  try {
    const me = req.auth.branchId;
    const result = await withBranch(me, async (c) => {
      const { rows } = await c.query("select * from branch_transfers where id = $1 and from_branch_id = $2 for update", [req.params.id, me]);
      const t = rows[0];
      if (!t) return { error: "transfer_not_found" };
      if (t.status !== "sent") return { error: `transfer_${t.status}` };
      const day = await getOpenBusinessDay(c, me);
      await c.query("update item_units set issued = false, issued_at = null, issued_by = null, transfer_id = null where transfer_id = $1", [t.id]);
      for (const l of t.lines) {
        await c.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'branch_transfer_cancel',$3,$4,$5,'1350','1210','branch_transfers',$6,$7,$8)`,
          [me, day?.id || null, l.karat, l.weight, fineWeight(l.weight, l.karat), t.id, `إلغاء ${t.ref} ${l.code}`, req.auth.userId]);
      }
      if (Number(t.total_cost) > 0) {
        await postJournalEntry(c, { branchId: me, businessDayId: day?.id || null, opType: "branch_transfer_cancel", refTable: "branch_transfers", refId: t.id,
          description: `إلغاء تحويل ${t.ref}`, createdBy: req.auth.userId,
          lines: [{ account: "5110", side: "debit", amount: Number(t.total_cost) }, { account: "1350", side: "credit", amount: Number(t.total_cost) }] });
      }
      const { rows: up } = await c.query("update branch_transfers set status = 'cancelled', cancelled_at = now() where id = $1 returning *", [t.id]);
      return { transfer: shape(up[0], me) };
    });
    if (result.error) return res.status(result.error === "transfer_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
