import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { roundWeight } from "../domain/weight.js";
import { isStocktakeLocked } from "../domain/saleOps.js";
import { hiddenConfig, setHiddenPin } from "../domain/hiddenMode.js";

const router = Router();

/**
 * الوضع الخفي (migration 047):
 *   POST /hidden/hold { codes, note }        — من الوضع الخفي وحده: يُخرج قطعًا من الرفّ (تُعلَّق)
 *   GET  /held-units                          — القطع المعلّقة (المدير)
 *   POST /held-units/release { code, note }   — يعيدها المدير إلى الرفّ
 *   GET  /settings/hidden-mode · PUT { enabled, pin } — المدير
 * ⚠ لا قيد ماليًّا ولا وزنيًّا: القطعة ما زالت ملك المحل وفي 1210 — خرجت من الرفّ
 *   لا من الدفتر، ويُكمَل بيعها في الوضع الكامل (البيع يأخذ المعلّقة أولًا).
 */
const unitKey = (c) => String(c || "").trim().toUpperCase();

router.post("/hidden/hold", authenticate, async (req, res, next) => {
  if (!req.auth.hidden) return res.status(403).json({ error: "hidden_mode_only" });
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : String(req.body?.codes || "").split(/[\s,،;]+/)).map(unitKey).filter(Boolean))];
  const note = String(req.body?.note || "").trim().slice(0, 200);
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      if (await isStocktakeLocked(client, req.auth.branchId)) return { error: "stocktake_locked" };
      const { rows } = await client.query(
        `select u.id, u.code, u.sold, u.issued, u.held, i.weight, i.reserved_for
           from item_units u join items i on i.id = u.item_id
          where i.branch_id = $1 and upper(u.code) = any($2::text[]) for update of u`,
        [req.auth.branchId, codes]
      );
      const byCode = new Map(rows.map((r) => [unitKey(r.code), r]));
      const errors = [];
      for (const c of codes) {
        const u = byCode.get(c);
        if (!u) errors.push(`الرمز ${c} ليس في المخزون`);
        else if (u.sold) errors.push(`الرمز ${c} مباعٌ من قبل`);
        else if (u.held) errors.push(`الرمز ${c} مُخرَجٌ من قبل`);
        else if (u.issued) errors.push(`الرمز ${c} أُخرج من النظام`);
        else if (u.reserved_for) errors.push(`الرمز ${c} محجوزٌ لعميل`);
      }
      if (errors.length) return { error: "hold_rejected", errors };
      const { rows: n } = await client.query(
        `select count(distinct held_ref)::int + 1 as n from item_units u join items i on i.id = u.item_id
          where i.branch_id = $1 and held_ref is not null`, [req.auth.branchId]);
      const ref = `HLD-${String(n[0].n).padStart(5, "0")}`;
      await client.query(
        `update item_units set held = true, held_at = now(), held_by = $2, held_ref = $3, held_note = $4,
                held_released_at = null, held_released_by = null
          where id = any($1::uuid[])`,
        [rows.map((r) => r.id), req.auth.user.name, ref, note || null]
      );
      const weight = roundWeight(rows.reduce((a, r) => a + Number(r.weight || 0), 0));
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'item_units',null,$2)`,
        [req.auth.branchId, JSON.stringify({ hiddenHold: true, ref, codes, weight, note })]
      );
      return { ref, codes, weight };
    });
    if (result.error === "stocktake_locked") return res.status(409).json(result);
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/held-units", authenticate, requireManager, async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select u.code, u.held_at, u.held_by, u.held_ref, u.held_note, i.id as item_id, i.karat, i.weight, i.ref as item_ref, c.name as category
         from item_units u join items i on i.id = u.item_id left join categories c on c.id = i.category_id
        where i.branch_id = $1 and u.held and not u.sold order by u.held_at`, [req.auth.branchId])).rows);
    res.json({ units: rows.map((r) => ({ code: r.code, itemId: r.item_id, karat: r.karat, weight: Number(r.weight), itemRef: r.item_ref || "",
      category: r.category || "", heldAt: r.held_at, heldBy: r.held_by || "", heldRef: r.held_ref || "", heldNote: r.held_note || "" })) });
  } catch (err) {
    next(err);
  }
});

router.post("/held-units/release", authenticate, requireManager, async (req, res, next) => {
  const code = unitKey(req.body?.code);
  if (!code) return res.status(400).json({ error: "codes_required" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update item_units u set held = false, held_released_at = now(), held_released_by = $3
           from items i where i.id = u.item_id and i.branch_id = $1 and upper(u.code) = $2 and u.held and not u.sold
         returning u.code`, [req.auth.branchId, code, req.auth.userId]);
      if (!rows[0]) return { error: "not_held" };
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'item_units',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ heldRelease: code, note: String(req.body?.note || "").slice(0, 200) })]
      );
      return { code: rows[0].code };
    });
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/settings/hidden-mode", authenticate, requireManager, async (req, res, next) => {
  try {
    const c = await withBranch(req.auth.branchId, (cl) => hiddenConfig(cl, req.auth.branchId));
    res.json({ enabled: c.enabled, isDefaultPin: c.isDefault });
  } catch (err) {
    next(err);
  }
});

router.put("/settings/hidden-mode", authenticate, requireManager, async (req, res, next) => {
  const b = req.body || {};
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      if (b.pin != null && b.pin !== "") {
        const r = await setHiddenPin(c, req.auth.branchId, b.pin);
        if (r.error) return r;
      }
      if (typeof b.enabled === "boolean") {
        await c.query(
          `insert into branch_settings (branch_id, hidden_mode_enabled) values ($1, $2)
           on conflict (branch_id) do update set hidden_mode_enabled = excluded.hidden_mode_enabled`,
          [req.auth.branchId, b.enabled]
        );
      }
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ hiddenMode: { enabled: b.enabled, pinChanged: !!b.pin } })]
      );
      const cfg = await hiddenConfig(c, req.auth.branchId);
      return { enabled: cfg.enabled, isDefaultPin: cfg.isDefault };
    });
    if (result.error) return res.status(result.error === "pin_taken" ? 409 : 400).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
