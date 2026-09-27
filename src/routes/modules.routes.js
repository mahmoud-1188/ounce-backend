import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager } from "../middleware/auth.js";
import { provisionLocked } from "../domain/branchProvision.js";
import { MODULES, loadModules, modCfg, modOn, sanitizeModules } from "../domain/modules.js";

const router = Router();

/** GET /settings/modules · PUT { modules } — الوحدات الاختيارية للفرع (migration 050) */
router.get("/settings/modules", authenticate, async (req, res, next) => {
  try {
    const modules = await withBranch(req.auth.branchId, (c) => loadModules(c, req.auth.branchId));
    res.json({ modules, catalog: Object.fromEntries(Object.entries(MODULES).map(([id, m]) => [id, { label: m.label, cfg: m.cfg }])) });
  } catch (err) {
    next(err);
  }
});

router.put("/settings/modules", authenticate, requireManager, async (req, res, next) => {
  const modules = sanitizeModules(req.body?.modules || {});
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      if (await provisionLocked(c, req.auth.branchId)) return { error: "settings_locked_by_hq" };
      await c.query(
        `insert into branch_settings (branch_id, modules) values ($1, $2)
         on conflict (branch_id) do update set modules = excluded.modules`,
        [req.auth.branchId, JSON.stringify(modules)]
      );
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ modules: Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, v.on])) })]
      );
      return { modules };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /reorder/status — حدود إعادة الطلب (وحدة reorderAlerts): لكل تصنيفٍ وعيار حدٌّ أدنى
 * من القطع على الرفّ، والتنبيه حين ينزل المتاح تحته.
 */
router.get("/reorder/status", authenticate, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const mods = await loadModules(c, req.auth.branchId);
      if (!modOn(mods, "reorderAlerts")) return { on: false, rows: [] };
      const mins = modCfg(mods, "reorderAlerts").mins || {};
      const { rows } = await c.query(
        `select i.category_id, i.karat, count(u.id)::int as n, coalesce(sum(i.weight), 0)::float8 as w
           from item_units u join items i on i.id = u.item_id
          where i.branch_id = $1 and not u.sold and not u.issued and not u.held
          group by 1, 2`, [req.auth.branchId]);
      const { rows: cats } = await c.query("select id, name from categories where branch_id = $1 or branch_id is null", [req.auth.branchId]);
      const nameOf = Object.fromEntries(cats.map((x) => [x.id, x.name]));
      const have = Object.fromEntries(rows.map((r) => [`${r.category_id}:${r.karat}`, r]));
      const list = Object.entries(mins).map(([k, min]) => {
        const [categoryId, karat] = k.split(":");
        const h = have[k] || { n: 0, w: 0 };
        return { key: k, categoryId, category: nameOf[categoryId] || categoryId, karat: Number(karat), min, available: h.n, weight: Math.round(h.w * 1000) / 1000,
          status: h.n === 0 ? "out" : h.n < min ? "low" : "ok", shortBy: Math.max(0, min - h.n) };
      }).sort((a, b) => ({ out: 0, low: 1, ok: 2 }[a.status] - { out: 0, low: 1, ok: 2 }[b.status]));
      return { on: true, rows: list };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
