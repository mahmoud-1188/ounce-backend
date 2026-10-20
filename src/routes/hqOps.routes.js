import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { wastageReport } from "./workshop.routes.js";
import { authenticateStore, requireCanManageBranches, requireCanSendCoding, requireStoreOwner } from "../middleware/storeAuth.js";
import { closeMonth, fiscalStatus } from "../domain/periodClose.js";
import { issueEnrollCode } from "../domain/enroll.js";
import { branchDevices, revokeDevice } from "../domain/devices.js";
import { codeRemnant, listRemnants } from "../domain/remnants.js";
import { codeLotItems } from "./items.routes.js";

const router = Router();

/**
 * عمليات الإدارة على الفروع (migration 061 — المرجع HqFiscalTab · HqRemoteStocktake · HqOrgChart):
 *   GET  /store/fiscal                               — حالة السنة لكل فرع: الأشهر المقفلة والمفتوحة وقفل الفترات
 *   POST /store/branches/:branchId/close-month { period }
 *   GET  /store/branches/:branchId/stocktake-sheet   — الأصناف وعدد القطع المتوقَّع على الرفّ
 *   POST /store/branches/:branchId/remote-stocktake { counts:[{itemId, countedQty}], note }
 *   GET  /store/branches/:branchId/remote-stocktakes
 *   GET  /store/ops-log                              — ما فعلته الإدارة في كل الفروع (من سجلّ تدقيقها)
 *   POST /store/branches/:branchId/users/:id/enroll-invite — رمز ربط جهاز لأي موظف (ومنهم المدير: الإدارة وحدها تربط جهاز المدير)
 *   PATCH /store/users/:id/hq-role { hqRole }       — الدور الوظيفي في الهيكل الإداري (تسعة أدوار المرجع)
 */
router.use("/store", authenticateStore);

async function storeBranches(storeId) {
  const { rows } = await withoutBranch((c) => c.query(
    "select id, name, ref, is_hq from branches where store_id = $1 and deleted_at is null order by created_at", [storeId]));
  return rows;
}
async function inStore(storeId, branchId) {
  return (await storeBranches(storeId)).find((b) => b.id === branchId) || null;
}

router.get("/store/fiscal", async (req, res, next) => {
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const out = [];
    for (const b of branches) out.push({ branchId: b.id, branchName: b.name, branchRef: b.ref, isHq: !!b.is_hq, ...(await withBranch(b.id, (c) => fiscalStatus(c, b.id))) });
    res.json({ branches: out });
  } catch (err) {
    next(err);
  }
});

router.post("/store/branches/:branchId/close-month", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    // إقفال الشهر في دفتر الإدارة يُمنع حتى تُقفل الفروع شهرها — فلا تُقفل المجموعة على أرقامٍ تتحرّك
    const period = String(req.body?.period || "");
    const { rows: brs } = await withoutBranch((c) => c.query(
      "select id, name, is_hq from branches where store_id = $1 and deleted_at is null", [req.storeAuth.storeId]));
    if (brs.find((b) => b.id === req.params.branchId)?.is_hq) {
      const open = [];
      for (const b of brs.filter((x) => !x.is_hq)) {
        const r = await withBranch(b.id, async (c) => {
          const { rows: [m] } = await c.query(
            `select exists (select 1 from journal_entries where branch_id = $1 and to_char(created_at at time zone 'Asia/Riyadh', 'YYYY-MM') = $2) as has,
                    exists (select 1 from period_closes where branch_id = $1 and period = $2) as closed`, [b.id, period]);
          return m;
        });
        if (r.has && !r.closed) open.push(b.name);
      }
      if (open.length) return res.status(409).json({ error: "branches_not_closed", branches: open });
    }
    const r = await withBranch(req.params.branchId, (c) => closeMonth(c, req.params.branchId, String(req.body?.period || ""), { by: `الإدارة — ${req.storeAuth.name || ""}`.trim(), kind: "store" }));
    if (r.error) return res.status(r.error === "invalid_period" ? 400 : 409).json(r);
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

// قفل الفترات لكل الفروع من الإدارة: «نهائي» لا يُسجَّل شيءٌ بتاريخه أو قبله، «جزئي» ما قبله للمدير وحده.
// يُحفظ قفلًا للإدارة بجانب قفل الفرع (النافذ أبعدهما)، وتفريغه يرفع قفل الإدارة وحده.
router.post("/store/period-locks", requireCanManageBranches, async (req, res, next) => {
  const d = (v) => (v == null || v === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : undefined);
  const lockAll = d(req.body?.lockAll), lockPosted = d(req.body?.lockPosted);
  if (lockAll === undefined || lockPosted === undefined) return res.status(400).json({ error: "invalid_lock_date" });
  try {
    const out = [];
    for (const b of await storeBranches(req.storeAuth.storeId)) {
      await withBranch(b.id, async (c) => {
        await c.query(
          `insert into branch_settings (branch_id, hq_lock_all, hq_lock_posted) values ($1,$2,$3)
           on conflict (branch_id) do update set hq_lock_all = excluded.hq_lock_all, hq_lock_posted = excluded.hq_lock_posted`,
          [b.id, lockAll, lockPosted]);
        await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'branch_settings',null,$2)`,
          [b.id, JSON.stringify({ hqPeriodLock: { lockAll, lockPosted }, by: req.storeAuth.name || "الإدارة" })]);
      });
      out.push({ branchId: b.id, name: b.name, ok: true });
    }
    res.json({ lockAll, lockPosted, branches: out });
  } catch (err) {
    next(err);
  }
});

// هدر التصنيع لكل فرع (المرجع WastageReportView للإدارة): نسبة الهدر ومسموحها والزائد وأعلى ورشة، والمطالبات المفتوحة
router.get("/store/wastage", async (req, res, next) => {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  try {
    const out = [];
    for (const b of await storeBranches(req.storeAuth.storeId)) {
      const r = await withBranch(b.id, (c) => wastageReport(c, b.id, { from: day(req.query.from), to: day(req.query.to) }));
      if (!r.total.jobs && !r.claims.rows.length && !r.receiving.length) continue;
      out.push({ branchId: b.id, name: b.name, ref: b.ref, ...r.total, top: r.byWorkshop[0] ? { name: r.byWorkshop[0].label, lossPct: r.byWorkshop[0].lossPct } : null,
        claims: r.claims, receiving: r.receiving.length,
        allowPct: r.rows.length ? Math.round(r.rows.reduce((a, x) => a + x.allowPct, 0) / r.rows.length * 100) / 100 : 0 });
    }
    res.json({ branches: out });
  } catch (err) {
    next(err);
  }
});

router.get("/store/branches/:branchId/stocktake-sheet", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const rows = await withBranch(req.params.branchId, async (c) => (await c.query(
      `select i.id, i.ref, i.karat, i.weight, coalesce(cat.name, '') as category,
              count(u.id) filter (where not u.sold and not u.issued)::int as expected
         from items i left join categories cat on cat.id = i.category_id left join item_units u on u.item_id = i.id
        where i.branch_id = $1 group by i.id, cat.name
       having count(u.id) filter (where not u.sold and not u.issued) > 0 order by cat.name, i.ref`, [req.params.branchId])).rows);
    // رموز القطع الحرّة لكل صنف — العدّ بالمسح يطابقها، والقفل وآخر الجرود ليرى المسؤول حال الفرع
    const extra = await withBranch(req.params.branchId, async (c) => ({
      units: (await c.query(
        `select u.item_id, u.code, u.epc, u.sold from item_units u join items i on i.id = u.item_id where i.branch_id = $1 and not u.issued`,
        [req.params.branchId])).rows,
      lock: (await c.query("select locked, locked_at, locked_by_name, by_hq from stocktake_locks where branch_id = $1", [req.params.branchId])).rows[0] || null,
      audits: (await c.query(
        `select created_at, details from audit_log where branch_id = $1 and ref_table = 'stocktake' order by created_at desc limit 8`, [req.params.branchId])).rows,
    }));
    const codesOf = new Map();
    for (const u of extra.units.filter((x) => !x.sold)) codesOf.set(u.item_id, [...(codesOf.get(u.item_id) || []), u.code]);
    res.json({
      items: rows.map((r) => ({ id: r.id, ref: r.ref, category: r.category, karat: r.karat, weight: Number(r.weight), expected: r.expected, codes: codesOf.get(r.id) || [] })),
      sold: extra.units.filter((x) => x.sold).map((x) => x.code),
      epcs: Object.fromEntries(extra.units.filter((x) => x.epc).map((x) => [String(x.epc).toUpperCase(), x.code])),
      lock: extra.lock && extra.lock.locked ? { at: extra.lock.locked_at, by: extra.lock.locked_by_name || "الفرع", byHq: !!extra.lock.by_hq } : null,
      audits: extra.audits.map((a) => ({ at: a.created_at, ...(a.details || {}) })),
    });
  } catch (err) {
    next(err);
  }
});

const shapeRst = (r) => ({ id: r.id, ref: r.ref, counts: r.counts || [], note: r.note || "", status: r.status, requestedBy: r.requested_by, requestedAt: r.requested_at,
  decidedAt: r.decided_at, decidedBy: r.decided_by_name || null, result: r.result || null, scan: r.scan || null, applyMode: r.apply_mode || "apply", unlock: r.unlock !== false });

// قفل مخزون الفرع للجرد من الإدارة: يتوقّف بيعه وتحويله حتى يُطبَّق الجرد أو يُفتح القفل
router.post("/store/branches/:branchId/stocktake-lock", requireCanManageBranches, async (req, res, next) => {
  const on = !!req.body?.on;
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const by = req.storeAuth.name || "الإدارة";
    const r = await withBranch(req.params.branchId, async (c) => {
      const { rows } = await c.query(
        `insert into stocktake_locks (branch_id, locked, locked_by, locked_at, locked_by_name, by_hq) values ($1,$2,null,$3,$4,$2)
         on conflict (branch_id) do update set locked = excluded.locked, locked_by = null, locked_at = excluded.locked_at,
           locked_by_name = excluded.locked_by_name, by_hq = excluded.by_hq
         returning locked, locked_at, locked_by_name`, [req.params.branchId, on, on ? new Date() : null, on ? `الإدارة — ${by}` : null]);
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'stocktake_locks',null,$2)`,
        [req.params.branchId, JSON.stringify({ hqStocktakeLock: on, by })]);
      return rows[0];
    });
    res.json({ lock: r.locked ? { at: r.locked_at, by: r.locked_by_name, byHq: true } : null });
  } catch (err) {
    next(err);
  }
});

router.post("/store/branches/:branchId/remote-stocktake", requireCanManageBranches, async (req, res, next) => {
  const counts = (Array.isArray(req.body?.counts) ? req.body.counts : [])
    .map((x) => ({ itemId: String(x.itemId || ""), countedQty: Number(x.countedQty),
      ...(Array.isArray(x.missingCodes) && x.missingCodes.length ? { missingCodes: x.missingCodes.map((c) => String(c).toUpperCase()).slice(0, 500) } : {}) }))
    .filter((x) => x.itemId);
  const applyMode = req.body?.applyMode === "report" ? "report" : "apply";
  const unlock = req.body?.unlock !== false;
  const sc = req.body?.scan && typeof req.body.scan === "object" ? req.body.scan : null;
  const scan = sc ? { matched: Number(sc.matched) || 0, missing: (sc.missing || []).map(String).slice(0, 500), unknown: (sc.unknown || []).map(String).slice(0, 200),
    soldFound: (sc.soldFound || []).map(String).slice(0, 200), expected: Number(sc.expected) || 0 } : null;
  if (!counts.length) return res.status(400).json({ error: "no_entries" });
  if (counts.some((x) => !Number.isInteger(x.countedQty) || x.countedQty < 0)) return res.status(400).json({ error: "invalid_entry" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const by = req.storeAuth.name || "الإدارة";
    const r = await withBranch(req.params.branchId, async (c) => {
      const { rows: ok } = await c.query("select id from items where branch_id = $1 and id = any($2::uuid[])", [req.params.branchId, counts.map((x) => x.itemId)]);
      if (ok.length !== new Set(counts.map((x) => x.itemId)).size) return { error: "item_not_found" };
      const { rows: [n] } = await c.query("select count(*)::int + 1 as n from remote_stocktakes where branch_id = $1", [req.params.branchId]);
      const { rows } = await c.query(
        `insert into remote_stocktakes (branch_id, ref, counts, note, requested_by, scan, apply_mode, unlock) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.params.branchId, `RST-${String(n.n).padStart(4, "0")}`, JSON.stringify(counts), String(req.body?.note || "").slice(0, 300) || null, by,
         scan ? JSON.stringify(scan) : null, applyMode, unlock]);
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',null,'remote_stocktakes',$2,$3)`,
        [req.params.branchId, rows[0].id, JSON.stringify({ kind: "remote_stocktake", by, byKind: "store", items: counts.length })]);
      return { stocktake: shapeRst(rows[0]) };
    });
    if (r.error) return res.status(404).json(r);
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

router.get("/store/branches/:branchId/remote-stocktakes", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const rows = await withBranch(req.params.branchId, async (c) => (await c.query(
      `select r.*, u.name as decided_by_name from remote_stocktakes r left join users u on u.id = r.decided_by
        where r.branch_id = $1 order by r.requested_at desc limit 50`, [req.params.branchId])).rows);
    res.json({ stocktakes: rows.map(shapeRst) });
  } catch (err) {
    next(err);
  }
});

router.get("/store/ops-log", async (req, res, next) => {
  try {
    const branches = await storeBranches(req.storeAuth.storeId);
    const all = [];
    for (const b of branches) {
      const rows = await withBranch(b.id, async (c) => (await c.query(
        `select id, event_type, ref_table, details, created_at from audit_log
          where branch_id = $1 and details->>'byKind' = 'store' order by created_at desc limit 100`, [b.id])).rows);
      all.push(...rows.map((a) => ({ id: a.id, branchId: b.id, branchName: b.name, event: a.event_type, table: a.ref_table,
        kind: a.details?.kind || a.ref_table, by: a.details?.by || "", details: a.details || {}, date: a.created_at })));
    }
    all.sort((x, y) => String(y.date).localeCompare(String(x.date)));
    res.json({ log: all.slice(0, 200) });
  } catch (err) {
    next(err);
  }
});

router.post("/store/branches/:branchId/users/:id/enroll-invite", requireCanManageBranches, async (req, res, next) => {
  try {
    const b = await inStore(req.storeAuth.storeId, req.params.branchId);
    if (!b) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, async (c) => {
      const { rows } = await c.query("select id, name, role from users where id = $1 and branch_id = $2 and active = true", [req.params.id, req.params.branchId]);
      if (!rows[0]) return { error: "not_found" };
      const out = await issueEnrollCode(c, { branchId: req.params.branchId, user: rows[0], createdBy: null,
        actor: { name: `الإدارة — ${req.storeAuth.name || ""}`.trim(), kind: "store" } });
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',null,'enroll_invites',null,$2)`,
        [req.params.branchId, JSON.stringify({ kind: "enroll_invite", by: req.storeAuth.name || "الإدارة", byKind: "store", user: rows[0].name })]);
      return { ...out, branchRef: b.ref, branchName: b.name };
    });
    if (r.error) return res.status(404).json(r);
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

// ── أجهزة الدخول المربوطة (migration 062): السياسة لكل فرع · القائمة · الإلغاء · رمز «جهاز الفرع» ──
router.get("/store/branches/:branchId/devices", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    res.json(await withBranch(req.params.branchId, (c) => branchDevices(c, req.params.branchId)));
  } catch (err) { next(err); }
});
router.put("/store/branches/:branchId/device-lock", requireCanManageBranches, async (req, res, next) => {
  const mode = String(req.body?.mode || "");
  if (!["off", "managers", "all"].includes(mode)) return res.status(400).json({ error: "invalid_mode" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const out = await withBranch(req.params.branchId, async (c) => {
      await c.query(`insert into branch_settings (branch_id, device_lock) values ($1,$2)
                     on conflict (branch_id) do update set device_lock = excluded.device_lock`, [req.params.branchId, mode]);
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'branch_settings',null,$2)`,
        [req.params.branchId, JSON.stringify({ kind: "device_lock", mode, by: req.storeAuth.name || "الإدارة", byKind: "store" })]);
      return branchDevices(c, req.params.branchId);
    });
    res.json(out);
  } catch (err) { next(err); }
});
router.post("/store/branches/:branchId/devices/:deviceId/revoke", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, async (c) => {
      const out = await revokeDevice(c, req.params.branchId, req.params.deviceId, `الإدارة — ${req.storeAuth.name || ""}`.trim());
      if (!out.error) await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'devices',$2,$3)`,
        [req.params.branchId, req.params.deviceId, JSON.stringify({ kind: "device_revoke", by: req.storeAuth.name || "الإدارة", byKind: "store" })]);
      return out;
    });
    if (r.error) return res.status(404).json(r);
    res.json(r);
  } catch (err) { next(err); }
});
router.post("/store/branches/:branchId/shared-device-invite", requireCanManageBranches, async (req, res, next) => {
  try {
    const b = await inStore(req.storeAuth.storeId, req.params.branchId);
    if (!b) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, (c) => issueEnrollCode(c, { branchId: req.params.branchId, user: null, createdBy: null,
      actor: { name: `الإدارة — ${req.storeAuth.name || ""}`.trim(), kind: "store" } }));
    res.status(201).json({ ...r, branchRef: b.ref, branchName: b.name });
  } catch (err) { next(err); }
});

const HQ_ROLE_IDS = ["chairman", "gm", "finance", "operations", "admin", "auditor", "hq_clerk", "hq_coder", "hq_warehouse"];
router.patch("/store/users/:id/hq-role", requireStoreOwner, async (req, res, next) => {
  const hqRole = req.body?.hqRole == null || req.body.hqRole === "" ? null : String(req.body.hqRole);
  if (hqRole && !HQ_ROLE_IDS.includes(hqRole)) return res.status(400).json({ error: "invalid_hq_role" });
  try {
    const { rows } = await withoutBranch((c) => c.query(
      "update store_users set hq_role = $1 where id = $2 and store_id = $3 returning id, hq_role", [hqRole, req.params.id, req.storeAuth.storeId]));
    if (!rows[0]) return res.status(404).json({ error: "user_not_found" });
    res.json({ id: rows[0].id, hqRole: rows[0].hq_role });
  } catch (err) {
    next(err);
  }
});

/**
 * بقايا الأطقم في فرع — تكويدها من الإدارة (المرجع 5.2.0: «تكويد بقايا طقم» · HqRemoteRemnants).
 * بالمعالج نفسه الذي في الفرع (القطع مجموع أوزانها وزن البقايا)، ولمن يملك التكويد في الإدارة.
 *   GET  /store/branches/:branchId/remnants
 *   POST /store/branches/:branchId/remnants/:itemId/code { pieces: [{ categoryId, weight }] }
 */
router.get("/store/branches/:branchId/remnants", async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const out = await withBranch(req.params.branchId, async (c) => ({
      remnants: await listRemnants(c, req.params.branchId),
      categories: (await c.query("select id, name, sale_mode from categories where (branch_id = $1 or branch_id is null) and sale_mode <> 'partial' order by sort_order, name", [req.params.branchId])).rows,
    }));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

router.post("/store/branches/:branchId/remnants/:itemId/code", requireCanSendCoding, async (req, res, next) => {
  const pieces = Array.isArray(req.body?.pieces) ? req.body.pieces : [];
  if (!pieces.length || pieces.some((p) => !p.categoryId || !(Number(p.weight) > 0))) return res.status(400).json({ error: "invalid_pieces" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, (c) => codeRemnant(c, {
      branchId: req.params.branchId, itemId: req.params.itemId, pieces, by: req.storeAuth.name || "الإدارة",
    }));
    if (r.error) return res.status(r.error === "item_not_found" ? 404 : 409).json(r);
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

/**
 * التكويد في الإدارة (migration 069): دفعاتٌ أرسلتها الفروع لتكوّدها الإدارة — بمعالج تكويد الفرع نفسه، والقطع تدخل
 * مخزون الفرع مباشرةً (الوزن لم يغادر 1210 عنده). ونموذج كل فرع: من يكوّد.
 *   GET  /store/coding-queue
 *   POST /store/branches/:branchId/lots/:lotId/items { rows, distributionMode }
 *   POST /store/branches/:branchId/coding-model { model: branch|hq|both }
 */
const CODING_MODELS = ["branch", "hq", "both"];
router.get("/store/coding-queue", async (req, res, next) => {
  try {
    const { rows: brs } = await withoutBranch((c) => c.query(
      "select id, name, ref from branches where store_id = $1 and deleted_at is null order by name", [req.storeAuth.storeId]));
    const branches = [];
    for (const b of brs) {
      const out = await withBranch(b.id, async (c) => {
        const { rows: lots } = await c.query(
          `select l.id, l.ref, l.karat, l.weight, l.cost_per_gram, l.workmanship_total, l.workmanship_allocated, l.sent_to_hq_at,
                  coalesce((select sum(i.weight * (select count(*) from item_units u where u.item_id = i.id)) from items i where i.lot_id = l.id), 0) as coded_weight
             from lots l where l.branch_id = $1 and l.status = 'open' and l.coding_at = 'hq' order by l.sent_to_hq_at`, [b.id]);
        const { rows: pieces } = lots.length
          ? await c.query(
            `select i.lot_id, u.code, u.printed, u.sold, i.weight, c.name as category
               from items i join item_units u on u.item_id = i.id left join categories c on c.id = i.category_id
              where i.lot_id = any($1::uuid[]) order by i.date_added, u.code`, [lots.map((l) => l.id)])
          : { rows: [] };
        const { rows: st } = await c.query("select coding_model from branch_settings where branch_id = $1", [b.id]);
        const { rows: cats } = lots.length
          ? await c.query("select id, name from categories where (branch_id = $1 or branch_id is null) and sale_mode <> 'partial' order by sort_order, name", [b.id])
          : { rows: [] };
        return { lots, pieces, model: st[0]?.coding_model || "both", categories: cats };
      });
      branches.push({ id: b.id, name: b.name, ref: b.ref, model: out.model, categories: out.categories,
        lots: out.lots.map((l) => ({ id: l.id, ref: l.ref, karat: l.karat, weight: Number(l.weight) || 0, codedWeight: Number(l.coded_weight) || 0,
          remaining: Math.max(0, Math.round(((Number(l.weight) || 0) - (Number(l.coded_weight) || 0)) * 1000) / 1000),
          costPerGram: Number(l.cost_per_gram) || 0, sentAt: l.sent_to_hq_at,
          pieces: out.pieces.filter((p) => p.lot_id === l.id).map((p) => ({ code: p.code, weight: Number(p.weight) || 0, category: p.category || "", printed: !!p.printed, sold: !!p.sold })),
          ageDays: Math.max(0, Math.floor((Date.now() - new Date(l.sent_to_hq_at || Date.now()).getTime()) / 864e5)) })) });
    }
    res.json({ branches });
  } catch (err) {
    next(err);
  }
});

router.post("/store/branches/:branchId/lots/:lotId/items", requireCanSendCoding, async (req, res, next) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const distributionMode = ["per_gram", "per_item", "by_karat"].includes(req.body?.distributionMode) ? req.body.distributionMode : "per_gram";
  if (!rows.length || rows.some((r) => !r.categoryId || !(Number(r.weight) > 0))) return res.status(400).json({ error: "invalid_rows" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const r = await withBranch(req.params.branchId, (c) => codeLotItems(c, {
      branchId: req.params.branchId, userId: null, lotId: req.params.lotId, rows, distributionMode, viaHq: true,
    }));
    if (r.error) return res.status(r.error === "lot_not_found" || r.error === "category_not_found" ? 404 : 409).json(r);
    res.status(201).json({ items: r.items });
  } catch (err) {
    next(err);
  }
});

/// مراجعة دورة التكويد قبل الشحن: ما كُوِّد خطأً يُلغى ووزنه يعود للدفعة ما دامت عند الإدارة، ثم «أنهِ وأرسل للفرع»
router.post("/store/branches/:branchId/lots/:lotId/uncode", requireCanSendCoding, async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 100);
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const out = await withBranch(req.params.branchId, async (c) => {
      const { rows: lr } = await c.query("select id, ref, status, coding_at from lots where id = $1 and branch_id = $2 for update", [req.params.lotId, req.params.branchId]);
      const lot = lr[0];
      if (!lot) return { error: "lot_not_found" };
      if (lot.status !== "open" || lot.coding_at !== "hq") return { error: "lot_not_at_hq" };
      const { rows } = await c.query(
        `select u.id, u.code, u.sold, u.issued, i.id as item_id, i.weight, i.lot_workmanship_share
           from item_units u join items i on i.id = u.item_id
          where i.lot_id = $1 and upper(u.code) = any($2::text[]) for update of u`, [lot.id, codes]);
      if (rows.length !== codes.length) return { error: "unit_not_found" };
      const bad = rows.find((r) => r.sold || r.issued);
      if (bad) return { error: "unit_not_available", code: bad.code };
      const share = rows.reduce((a, r) => a + (Number(r.lot_workmanship_share) || 0), 0);
      if (share > 0) await c.query("update lots set workmanship_allocated = greatest(0, workmanship_allocated - $2) where id = $1", [lot.id, Math.round(share * 100) / 100]);
      await c.query("delete from item_units where id = any($1::uuid[])", [rows.map((r) => r.id)]);
      await c.query(
        `delete from items i where i.id = any($1::uuid[]) and not exists (select 1 from item_units u where u.item_id = i.id)
            and not exists (select 1 from sale_lines s where s.item_id = i.id)`, [[...new Set(rows.map((r) => r.item_id))]]);
      const weight = Math.round(rows.reduce((a, r) => a + Number(r.weight), 0) * 1000) / 1000;
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'delete',null,'lots',$2,$3)`,
        [req.params.branchId, lot.id, JSON.stringify({ action: "hq_uncode", lot: lot.ref, codes, weight })]);
      return { ok: true, codes, weight };
    });
    if (out.error) return res.status(out.error === "lot_not_found" || out.error === "unit_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

router.post("/store/branches/:branchId/lots/:lotId/ship", requireCanSendCoding, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const out = await withBranch(req.params.branchId, async (c) => {
      const { rows: lr } = await c.query("select id, ref, status, coding_at from lots where id = $1 and branch_id = $2 for update", [req.params.lotId, req.params.branchId]);
      const lot = lr[0];
      if (!lot) return { error: "lot_not_found" };
      if (lot.status !== "open" || lot.coding_at !== "hq") return { error: "lot_not_at_hq" };
      const { rows: pc } = await c.query("select count(*)::int n from item_units u join items i on i.id = u.item_id where i.lot_id = $1", [lot.id]);
      if (!pc[0].n) return { error: "nothing_coded" };
      await c.query("update lots set coding_at = 'branch' where id = $1", [lot.id]);
      await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',null,'lots',$2,$3)`,
        [req.params.branchId, lot.id, JSON.stringify({ action: "hq_ship_coded", lot: lot.ref, pieces: pc[0].n })]);
      return { ok: true, lot: lot.ref, pieces: pc[0].n };
    });
    if (out.error) return res.status(out.error === "lot_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

router.post("/store/branches/:branchId/coding-model", requireCanManageBranches, async (req, res, next) => {
  const model = req.body?.model;
  if (!CODING_MODELS.includes(model)) return res.status(400).json({ error: "invalid_model" });
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    await withBranch(req.params.branchId, (c) => c.query(
      `insert into branch_settings (branch_id, coding_model) values ($1, $2)
       on conflict (branch_id) do update set coding_model = excluded.coding_model`, [req.params.branchId, model]));
    res.json({ model });
  } catch (err) {
    next(err);
  }
});

// التفويض بضغطة (migration 072): «تفويض كامل للفرع» و«بلا موافقات» — ضغطةٌ تشغّل وضغطةٌ تُطفئ
router.get("/store/branches/:branchId/delegation", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const { rows } = await withoutBranch((c) => c.query("select delegation from branches where id = $1", [req.params.branchId]));
    const d = rows[0]?.delegation || {};
    res.json({ delegation: { full: d.full === true, noApprovals: d.noApprovals === true } });
  } catch (err) { next(err); }
});
router.post("/store/branches/:branchId/delegation", requireCanManageBranches, async (req, res, next) => {
  const b = req.body || {};
  try {
    if (!(await inStore(req.storeAuth.storeId, req.params.branchId))) return res.status(404).json({ error: "branch_not_found" });
    const { rows } = await withoutBranch((c) => c.query("select delegation from branches where id = $1", [req.params.branchId]));
    const cur = rows[0]?.delegation || {};
    const next = { full: b.full != null ? !!b.full : cur.full === true, noApprovals: b.noApprovals != null ? !!b.noApprovals : cur.noApprovals === true };
    await withBranch(req.params.branchId, async (c) => {
      await c.query("update branches set delegation = $2 where id = $1", [req.params.branchId, JSON.stringify(next)]);
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',null,'branches',$1,$2)`,
        [req.params.branchId, JSON.stringify({ action: "delegation", by: req.storeAuth.name || "الإدارة", from: cur, to: next })]);
    });
    res.json({ delegation: next });
  } catch (err) { next(err); }
});

export default router;
