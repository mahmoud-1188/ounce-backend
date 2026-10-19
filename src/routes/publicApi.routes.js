import { Router } from "express";
import crypto from "node:crypto";
import { withoutBranch } from "../db.js";
import { authenticateStore, requireStoreOwner } from "../middleware/storeAuth.js";

/**
 * الواجهة البرمجية العامّة v1 (migration 083) — قراءةٌ فقط للأنظمة الأخرى (محاسبة خارجية · لوحات · متجر):
 *   GET /api/v1/health
 *   GET /api/v1/branches
 *   GET /api/v1/{branch}/{resource}?since=<ms>&limit=<n>   — الأحدث بعد since، و next_since للصفحة التالية
 * المفتاح في X-Api-Key أو Authorization: Bearer. الغلاف واحد: { ok, data, meta, error }. حدٌّ لكل مفتاح 120 طلبًا في الدقيقة.
 * والإدارة (المالك) تُصدر المفاتيح وتلغيها: /store/api-keys
 */
const router = Router();
const API_VERSION = "v1";
const KEY_RE = /^ounce_[0-9a-f]{48}$/;
const MAX_LIMIT = 1000, DEFAULT_LIMIT = 500, PER_MINUTE = 120;
// المورد ← جدوله وعمود وقته (كلّه مقيّدٌ بالفرع)
const RESOURCES = {
  items: { table: "items", at: "date_added" },
  sales: { table: "sales", at: "date" },
  returns: { table: "returns", at: "created_at" },
  journal: { table: "journal_entries", at: "created_at", lines: true },
  gold_ledger: { table: "gold_ledger_entries", at: "created_at" },
  customers: { table: "customers", at: "created_at" },
  suppliers: { table: "suppliers", at: "created_at" },
  lots: { table: "lots", at: "date" },
  expenses: { table: "expenses", at: "created_at" },
  receipts: { table: "receipts", at: "created_at" },
  scrap: { table: "scrap_items", at: "created_at" },
  safe: { table: "cash_tx", at: "created_at", where: "pool = 'safe'" },
};
// حقولٌ لا تخرج من الخادم أبدًا
const HIDDEN = new Set(["password_hash", "pin_hash", "recovery_hash"]);
const envelope = (ok, data = null, meta = null, error = null) => ({ ok, data, meta, error });
const hashKey = (k) => crypto.createHash("sha256").update(k).digest("hex");

const hits = new Map();
const allow = (id) => {
  const w = Math.floor(Date.now() / 60000), cur = hits.get(id);
  if (!cur || cur.w !== w) { hits.set(id, { w, n: 1 }); return true; }
  cur.n += 1;
  return cur.n <= PER_MINUTE;
};

function keyOf(req) {
  const direct = String(req.headers["x-api-key"] || "").trim();
  if (direct) return direct;
  const auth = String(req.headers.authorization || "").trim();
  return /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, "").trim() : "";
}

async function apiKeyGuard(req, res, next) {
  const key = keyOf(req);
  if (!key) return res.status(401).json(envelope(false, null, null, "المفتاح مطلوب في X-Api-Key"));
  if (!KEY_RE.test(key)) return res.status(401).json(envelope(false, null, null, "صيغة المفتاح غير صالحة"));
  try {
    const { rows } = await withoutBranch((c) => c.query("select id, store_id, scope from api_keys where key_hash = $1 and revoked_at is null", [hashKey(key)]));
    if (!rows[0]) return res.status(401).json(envelope(false, null, null, "مفتاحٌ غير صالح أو ملغى"));
    if (!allow(rows[0].id)) return res.status(429).json(envelope(false, null, null, "طلباتٌ كثيرة — انتظر دقيقة"));
    req.apiKey = rows[0];
    // السجلّ بعد الردّ: المسار وحالته وعدد السطور
    res.on("finish", () => {
      withoutBranch((c) => c.query("insert into api_log (key_id, path, status, rows) values ($1,$2,$3,$4)",
        [rows[0].id, req.originalUrl.slice(0, 200), res.statusCode, res.locals.apiRows || 0])
        .then(() => c.query("update api_keys set last_used_at = now() where id = $1", [rows[0].id]))).catch(() => {});
    });
    next();
  } catch (err) { next(err); }
}

router.get(`/${API_VERSION}/health`, (req, res) => res.json(envelope(true, { version: API_VERSION, resources: Object.keys(RESOURCES) })));

router.get(`/${API_VERSION}/branches`, apiKeyGuard, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(
      `select ref as code, name, created_at from branches where store_id = $1 and deleted_at is null and ($2 = 'ALL' or upper(ref) = upper($2)) order by name`,
      [req.apiKey.store_id, req.apiKey.scope]));
    res.locals.apiRows = rows.length;
    res.json(envelope(true, rows, { count: rows.length }));
  } catch (err) { next(err); }
});

router.get(`/${API_VERSION}/:branch/:resource`, apiKeyGuard, async (req, res, next) => {
  const branch = String(req.params.branch || "").toUpperCase(), resource = String(req.params.resource || "").toLowerCase();
  const R = RESOURCES[resource];
  if (!/^[A-Z0-9_-]{1,32}$/.test(branch)) return res.status(400).json(envelope(false, null, null, "رمز الفرع غير صالح"));
  if (!R) return res.status(404).json(envelope(false, null, null, `موردٌ غير معروف — المتاح: ${Object.keys(RESOURCES).join(" · ")}`));
  if (req.apiKey.scope !== "ALL" && req.apiKey.scope.toUpperCase() !== branch) return res.status(403).json(envelope(false, null, null, "المفتاح لا يشمل هذا الفرع"));
  const since = Math.max(0, Math.floor(Number(req.query.since) || 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(req.query.limit) || DEFAULT_LIMIT)));
  try {
    const out = await withoutBranch(async (c) => {
      const { rows: br } = await c.query("select id, ref from branches where store_id = $1 and deleted_at is null and upper(ref) = $2", [req.apiKey.store_id, branch]);
      if (!br[0]) return { notFound: true };
      // الجدول والعمود من القائمة الثابتة أعلاه وحدها — لا من الطلب
      const { rows } = await c.query(
        `select t.*, (extract(epoch from t.${R.at}::timestamptz) * 1000)::bigint as _at from ${R.table} t
          where t.branch_id = $1 and t.${R.at}::timestamptz > to_timestamp($2::double precision / 1000)${R.where ? ` and t.${R.where}` : ""}
          order by t.${R.at} asc limit $3`, [br[0].id, since, limit + 1]);
      const more = rows.length > limit;
      let page = rows.slice(0, limit);
      // سطورٌ بالوقت نفسه (قيدٌ واحد بعدّة سطور) لا تنقسم بين صفحتين: آخر وقتٍ في صفحةٍ ناقصة يُترك للصفحة التالية
      if (more) {
        const lastAt = page[page.length - 1]._at;
        const cut = page.filter((r) => r._at !== lastAt);
        if (cut.length) page = cut;
      }
      if (R.lines && page.length) {
        const { rows: ls } = await c.query("select entry_id, account_code, side, amount from journal_lines where entry_id = any($1::uuid[]) order by entry_id", [page.map((r) => r.id)]);
        const by = new Map(); ls.forEach((l) => { if (!by.has(l.entry_id)) by.set(l.entry_id, []); by.get(l.entry_id).push({ account: l.account_code, side: l.side, amount: Number(l.amount) }); });
        page.forEach((r) => { r.lines = by.get(r.id) || []; });
      }
      return { branch: br[0].ref, page, more };
    });
    if (out.notFound) return res.status(404).json(envelope(false, null, null, "فرعٌ غير موجود"));
    const data = out.page.map((r) => { const o = {}; for (const [k, v] of Object.entries(r)) if (!HIDDEN.has(k) && k !== "_at" && k !== "branch_id") o[k] = v; return o; });
    const nextSince = out.page.length ? Number(out.page[out.page.length - 1]._at) : since;
    res.locals.apiRows = data.length;
    res.json(envelope(true, data, { branch: out.branch, resource, count: data.length, next_since: nextSince, has_more: out.more }));
  } catch (err) { next(err); }
});

// القراءة فقط في هذا الإصدار
router.all(`/${API_VERSION}/*`, (req, res) => res.status(405).json(envelope(false, null, null, "القراءة فقط في هذا الإصدار — GET")));

// ── الإدارة: إصدار المفاتيح وإلغاؤها (المالك وحده) ──
router.get("/store/api-keys", authenticateStore, requireStoreOwner, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(
      `select k.id, k.label, k.key_hint, k.scope, k.created_at, k.last_used_at, k.revoked_at, u.name as created_name,
              (select count(*)::int from api_log l where l.key_id = k.id and l.at > now() - interval '1 day') as calls_24h
         from api_keys k left join store_users u on u.id = k.created_by where k.store_id = $1 order by k.revoked_at nulls first, k.created_at desc`,
      [req.storeAuth.storeId]));
    res.json({ keys: rows.map((r) => ({ id: r.id, label: r.label, hint: r.key_hint, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at, createdBy: r.created_name, calls24h: r.calls_24h })) });
  } catch (err) { next(err); }
});

router.post("/store/api-keys", authenticateStore, requireStoreOwner, async (req, res, next) => {
  const label = String(req.body?.label || "").trim().slice(0, 60);
  const scope = String(req.body?.scope || "ALL").trim().toUpperCase() || "ALL";
  if (!label) return res.status(400).json({ error: "label_required" });
  try {
    const out = await withoutBranch(async (c) => {
      if (scope !== "ALL") {
        const { rows } = await c.query("select 1 from branches where store_id = $1 and deleted_at is null and upper(ref) = $2", [req.storeAuth.storeId, scope]);
        if (!rows[0]) return { error: "branch_not_found" };
      }
      const key = `ounce_${crypto.randomBytes(24).toString("hex")}`;
      const { rows } = await c.query(
        "insert into api_keys (store_id, label, key_hash, key_hint, scope, created_by) values ($1,$2,$3,$4,$5,$6) returning id",
        [req.storeAuth.storeId, label, hashKey(key), key.slice(-4), scope, req.storeAuth.storeUserId]);
      return { id: rows[0].id, key, hint: key.slice(-4), scope, label };
    });
    if (out.error) return res.status(404).json(out);
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.post("/store/api-keys/:id/revoke", authenticateStore, requireStoreOwner, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(
      "update api_keys set revoked_at = now() where id = $1 and store_id = $2 and revoked_at is null returning id", [req.params.id, req.storeAuth.storeId]));
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
