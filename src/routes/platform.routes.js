import { Router } from "express";
import { pool, withoutBranch } from "../db.js";
import { hashPassword, verifyPassword } from "../auth/hashPassword.js";
import { signPlatformSession } from "../auth/jwt.js";
import { authenticatePlatform, requirePlatformAdminKey } from "../middleware/platformAuth.js";

/**
 * لوحة أدمن المنصة (ounce-admin) — migration 032.
 *
 * نقلٌ لمفاهيم صفحة «تصاريح الاشتراك» المحلية الأولية إلى الخادم:
 *   ترخيص شركة  → إنشاء متجر حقيقي + حساب مالكه (POST /platform/stores)
 *   مدة الاشتراك → stores.subscription_expires_at (0 شهر = بلا انتهاء)
 *   تحقّق       → تفاصيل المتجر وحالته الفعلية (GET /platform/stores/:id)
 *   السجل       → platform_log في القاعدة (GET /platform/log)
 *   نموذج الفرع → branches.operating_model (PATCH /platform/branches/:id/operating-model)
 *
 * لا رموز ولا بصمات هنا: الترخيص حالةٌ في القاعدة يفرضها الخادم على كل
 * طلب (storeAuth.js للمركزي، auth.js للفرع)، فلا شيء في يد العميل يُزوَّر.
 */
const router = Router();

const PLANS = ["central", "branch_only"];
const OPERATING_MODELS = ["full", "coding_only_hq", "sales_only", "approval_only"];
// متجرٌ ينتهي اشتراكه خلال هذه المدة يُعلَّم «قارب الانتهاء» في اللوحة.
const EXPIRING_SOON_DAYS = 14;

/** معاملة حقيقية (all-or-nothing) — الفعل وسجلّه يُكتبان معًا أو لا شيء. */
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function logAction(client, { adminId, action, storeId = null, branchId = null, details = {} }) {
  return client.query(
    `insert into platform_log (admin_id, action, store_id, branch_id, details)
     values ($1, $2, $3, $4, $5)`,
    [adminId, action, storeId, branchId, JSON.stringify(details)]
  );
}

/** حالة الاشتراك الفعلية كما يراها الخادم عند التحقق — لا كما خُزِّنت فقط. */
function subscriptionState(store) {
  if (store.status !== "active") return "suspended";
  if (!store.subscription_expires_at) return "active";
  const left = new Date(store.subscription_expires_at).getTime() - Date.now();
  if (left < 0) return "expired";
  if (left < EXPIRING_SOON_DAYS * 86400000) return "expiring";
  return "active";
}

function shapeStore(s) {
  return {
    id: s.id,
    name: s.name,
    plan: s.plan,
    maxBranches: s.max_branches,
    branchCount: s.branch_count ?? null,
    expiresAt: s.subscription_expires_at,
    status: s.status,
    state: subscriptionState(s),
    createdAt: s.created_at,
    owner: s.owner || null,
  };
}

/** عدد صحيح غير سالب أو null إن كانت القيمة غير صالحة. */
function toNonNegInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

const STORE_LIST_SQL = `
  select s.*,
         (select count(*)::int from branches b where b.store_id = s.id and b.deleted_at is null) as branch_count,
         (select json_build_object('name', su.name, 'email', su.email)
            from store_users su
           where su.store_id = s.id and su.role = 'owner'
           order by su.created_at
           limit 1) as owner
    from stores s`;

// ═══════════════════════ الدخول (علنيّ) ═══════════════════════

/**
 * GET /api/platform/auth/setup-status → { needsSetup }
 * هل المنصة بلا أي أدمن بعد؟ اللوحة تعرض شاشة «إنشاء أول حساب» بدل الدخول.
 */
router.get("/platform/auth/setup-status", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(`select count(*)::int as n from platform_admins`));
    res.json({ needsSetup: rows[0].n === 0 });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/platform/auth/setup  { name, email, password }
 * (رأس x-platform-admin-key)
 *
 * ينشئ أول حساب أدمن فقط — يُرفض إن وُجد أي حساب مسبقًا، فالمفتاح السري
 * لا يصلح بعدها لإنشاء حسابات إضافية من خارج اللوحة.
 */
router.post("/platform/auth/setup", requirePlatformAdminKey, async (req, res, next) => {
  const { name, email, password } = req.body || {};
  if (!String(name || "").trim() || !String(email || "").trim()) {
    return res.status(400).json({ error: "name_and_email_required" });
  }
  if (String(password || "").length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }
  try {
    const passwordHash = await hashPassword(password);
    const result = await inTx(async (client) => {
      // ⚠ قفل الجدول يمنع طلبين متزامنين من إنشاء «أول» أدمن معًا.
      await client.query("lock table platform_admins in exclusive mode");
      const { rows: cnt } = await client.query(`select count(*)::int as n from platform_admins`);
      if (cnt[0].n > 0) return { error: "already_set_up" };
      const { rows } = await client.query(
        `insert into platform_admins (name, email, password_hash)
         values ($1, $2, $3) returning id, name, email`,
        [String(name).trim(), String(email).trim(), passwordHash]
      );
      await logAction(client, { adminId: rows[0].id, action: "admin_setup", details: { email: rows[0].email } });
      return { admin: rows[0] };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json({ token: signPlatformSession(result.admin), admin: result.admin });
  } catch (err) {
    next(err);
  }
});

/** POST /api/platform/auth/login  { email, password } */
router.post("/platform/auth/login", async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });
  try {
    const { rows } = await withoutBranch((c) =>
      c.query(`select * from platform_admins where email = $1 and active = true`, [String(email).trim()])
    );
    const admin = rows[0];
    // ⚠ نفس الرسالة لبريدٍ غير موجود ولكلمة مرورٍ خاطئة — لا نكشف أيّهما.
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      return res.status(401).json({ error: "invalid_credentials" });
    }
    await withoutBranch((c) => c.query(`update platform_admins set last_login_at = now() where id = $1`, [admin.id]));
    res.json({
      token: signPlatformSession(admin),
      admin: { id: admin.id, name: admin.name, email: admin.email },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════ كل ما بعده بجلسة أدمن ═══════════════════════

router.use("/platform", authenticatePlatform);

router.get("/platform/auth/me", (req, res) => {
  res.json({ admin: { id: req.platformAuth.adminId, name: req.platformAuth.name, email: req.platformAuth.email } });
});

/** GET /api/platform/stores — كل المتاجر مع عدد فروعها ومالكها وحالة اشتراكها. */
router.get("/platform/stores", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((c) => c.query(`${STORE_LIST_SQL} order by s.created_at desc`));
    res.json({ stores: rows.map(shapeStore) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/platform/stores
 *   { name, plan, maxBranches, months, ownerName, ownerEmail, ownerPassword }
 *
 * نظير «أصدر ترخيص الشركة» في النموذج الأولي، لكنه ينشئ المتجر وحساب
 * مالكه فعليًّا في معاملةٍ واحدة — المالك يدخل تطبيق المركزي فورًا وينشئ
 * فروعه داخل السقف. months = 0 يعني بلا انتهاء (نفس اتفاقية النموذج).
 * باقة branch_only تعني فرعًا واحدًا فقط، فسقفها 1 دائمًا مهما أُرسل.
 */
router.post("/platform/stores", async (req, res, next) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const plan = b.plan || "central";
  const months = toNonNegInt(b.months ?? 12);
  let maxBranches = toNonNegInt(b.maxBranches ?? 1);
  const ownerName = String(b.ownerName || "").trim();
  const ownerEmail = String(b.ownerEmail || "").trim();
  const ownerPassword = String(b.ownerPassword || "");

  if (!name) return res.status(400).json({ error: "store_name_required" });
  if (!PLANS.includes(plan)) return res.status(400).json({ error: "invalid_plan" });
  if (months === null) return res.status(400).json({ error: "invalid_months" });
  if (!maxBranches || maxBranches < 1) return res.status(400).json({ error: "invalid_max_branches" });
  if (plan === "branch_only") maxBranches = 1;
  if (!ownerName || !ownerEmail) return res.status(400).json({ error: "owner_name_and_email_required" });
  if (ownerPassword.length < 8) return res.status(400).json({ error: "password_too_short" });

  try {
    const passwordHash = await hashPassword(ownerPassword);
    const store = await inTx(async (client) => {
      const { rows } = await client.query(
        `insert into stores (name, plan, max_branches, subscription_expires_at, status)
         values ($1, $2, $3,
                 case when $4::int = 0 then null else now() + make_interval(months => $4::int) end,
                 'active')
         returning *`,
        [name, plan, maxBranches, months]
      );
      const s = rows[0];
      await client.query(
        `insert into store_users (store_id, name, email, password_hash, role)
         values ($1, $2, $3, $4, 'owner')`,
        [s.id, ownerName, ownerEmail, passwordHash]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_created",
        storeId: s.id,
        details: { name, plan, maxBranches, months, expiresAt: s.subscription_expires_at, ownerEmail },
      });
      return { ...s, branch_count: 0, owner: { name: ownerName, email: ownerEmail } };
    });
    res.status(201).json({ store: shapeStore(store) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_used" });
    next(err);
  }
});

/** GET /api/platform/stores/:id — المتجر + فروعه + حسابات المركزي فيه. */
router.get("/platform/stores/:id", async (req, res, next) => {
  try {
    const data = await withoutBranch(async (c) => {
      const { rows } = await c.query(`${STORE_LIST_SQL} where s.id = $1`, [req.params.id]);
      if (!rows[0]) return null;
      const { rows: branches } = await c.query(
        `select b.id, b.ref, b.name, b.is_hq, b.operating_model, b.created_at, b.deleted_at,
                (select count(*)::int from users u where u.branch_id = b.id and u.active = true) as user_count
           from branches b
          where b.store_id = $1
          order by b.deleted_at nulls first, b.is_hq desc, b.created_at`,
        [req.params.id]
      );
      const { rows: storeUsers } = await c.query(
        `select id, name, email, role, active, created_at
           from store_users where store_id = $1 order by created_at`,
        [req.params.id]
      );
      return { store: rows[0], branches, storeUsers };
    });
    if (!data) return res.status(404).json({ error: "store_not_found" });
    res.json({
      store: shapeStore(data.store),
      branches: data.branches.map((b) => ({
        id: b.id,
        ref: b.ref,
        name: b.name,
        isHq: b.is_hq,
        operatingModel: b.operating_model,
        userCount: b.user_count,
        createdAt: b.created_at,
        deletedAt: b.deleted_at,
      })),
      storeUsers: data.storeUsers.map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.created_at,
      })),
    });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "store_not_found" });
    next(err);
  }
});

/**
 * PATCH /api/platform/stores/:id  { name?, plan?, maxBranches?, expiresAt? }
 * expiresAt: تاريخ ISO أو null (= بلا انتهاء).
 *
 * ⚠ لا يُخفَّض السقف تحت عدد الفروع العاملة فعلًا — وإلا صار المتجر
 * «فوق سقفه» بلا معنى. يُحذف فرعٌ من المركزي أولًا ثم يُخفَّض.
 */
router.patch("/platform/stores/:id", async (req, res, next) => {
  const b = req.body || {};
  try {
    const result = await inTx(async (client) => {
      const { rows } = await client.query(
        `select s.*,
                (select count(*)::int from branches br where br.store_id = s.id and br.deleted_at is null) as branch_count
           from stores s where s.id = $1 for update`,
        [req.params.id]
      );
      const cur = rows[0];
      if (!cur) return { status: 404, body: { error: "store_not_found" } };

      const nv = {
        name: b.name !== undefined ? String(b.name).trim() : cur.name,
        plan: b.plan !== undefined ? b.plan : cur.plan,
        maxBranches: b.maxBranches !== undefined ? toNonNegInt(b.maxBranches) : cur.max_branches,
        expiresAt: b.expiresAt !== undefined ? b.expiresAt : cur.subscription_expires_at,
      };
      if (!nv.name) return { status: 400, body: { error: "store_name_required" } };
      if (!PLANS.includes(nv.plan)) return { status: 400, body: { error: "invalid_plan" } };
      if (!nv.maxBranches || nv.maxBranches < 1) return { status: 400, body: { error: "invalid_max_branches" } };
      if (nv.plan === "branch_only") nv.maxBranches = 1;
      if (nv.expiresAt !== null && Number.isNaN(new Date(nv.expiresAt).getTime())) {
        return { status: 400, body: { error: "invalid_expires_at" } };
      }
      if (nv.maxBranches < cur.branch_count) {
        return { status: 409, body: { error: "max_below_current", branchCount: cur.branch_count } };
      }

      const { rows: upd } = await client.query(
        `update stores set name = $1, plan = $2, max_branches = $3, subscription_expires_at = $4
          where id = $5 returning *`,
        [nv.name, nv.plan, nv.maxBranches, nv.expiresAt, cur.id]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_updated",
        storeId: cur.id,
        details: {
          before: { name: cur.name, plan: cur.plan, maxBranches: cur.max_branches, expiresAt: cur.subscription_expires_at },
          after: { name: upd[0].name, plan: upd[0].plan, maxBranches: upd[0].max_branches, expiresAt: upd[0].subscription_expires_at },
        },
      });
      return { status: 200, body: { store: shapeStore({ ...upd[0], branch_count: cur.branch_count }) } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "store_not_found" });
    next(err);
  }
});

/**
 * POST /api/platform/stores/:id/renew  { months }
 *
 * التجديد يُضاف من تاريخ الانتهاء الحالي إن لم يأتِ بعد (لا يخسر العميل
 * ما بقي من اشتراكه)، ومن اليوم إن كان منتهيًا. months = 0 → بلا انتهاء.
 * متجرٌ موقوف يبقى موقوفًا — التجديد لا يرفع الإيقاف (فعلان مختلفان).
 */
router.post("/platform/stores/:id/renew", async (req, res, next) => {
  const months = toNonNegInt(req.body?.months);
  if (months === null) return res.status(400).json({ error: "invalid_months" });
  try {
    const result = await inTx(async (client) => {
      const { rows: curRows } = await client.query(
        `select subscription_expires_at from stores where id = $1 for update`,
        [req.params.id]
      );
      if (!curRows[0]) return null;
      const { rows } = await client.query(
        `update stores
            set subscription_expires_at = case
                  when $2::int = 0 then null
                  else greatest(coalesce(subscription_expires_at, now()), now()) + make_interval(months => $2::int)
                end,
                status = case when status = 'expired' then 'active' else status end
          where id = $1
          returning *,
            (select count(*)::int from branches b where b.store_id = stores.id and b.deleted_at is null) as branch_count`,
        [req.params.id, months]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_renewed",
        storeId: req.params.id,
        details: { months, before: curRows[0].subscription_expires_at, after: rows[0].subscription_expires_at },
      });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "store_not_found" });
    res.json({ store: shapeStore(result) });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "store_not_found" });
    next(err);
  }
});

/**
 * POST /api/platform/stores/:id/status  { status: "active" | "suspended", reason? }
 * الإيقاف يسري فورًا على المركزي وكل فروع المتجر عند أول طلبٍ لاحق.
 */
router.post("/platform/stores/:id/status", async (req, res, next) => {
  const status = req.body?.status;
  const reason = String(req.body?.reason || "").trim() || null;
  if (!["active", "suspended"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  try {
    const result = await inTx(async (client) => {
      const { rows: curRows } = await client.query(`select status from stores where id = $1 for update`, [req.params.id]);
      if (!curRows[0]) return null;
      const { rows } = await client.query(
        `update stores set status = $2 where id = $1
          returning *,
            (select count(*)::int from branches b where b.store_id = stores.id and b.deleted_at is null) as branch_count`,
        [req.params.id, status]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: status === "suspended" ? "store_suspended" : "store_activated",
        storeId: req.params.id,
        details: { before: curRows[0].status, after: status, reason },
      });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "store_not_found" });
    res.json({ store: shapeStore(result) });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "store_not_found" });
    next(err);
  }
});

/**
 * PATCH /api/platform/branches/:id/operating-model  { operatingModel }
 * يُحفظ الآن ويظهر في اللوحة؛ فرضه على الشراء والتكويد في تطبيق الفرع
 * مرحلةٌ لاحقة (راجع migration 032).
 */
router.patch("/platform/branches/:id/operating-model", async (req, res, next) => {
  const model = req.body?.operatingModel;
  if (!OPERATING_MODELS.includes(model)) return res.status(400).json({ error: "invalid_operating_model" });
  try {
    const result = await inTx(async (client) => {
      const { rows: curRows } = await client.query(
        `select id, store_id, name, operating_model from branches where id = $1 for update`,
        [req.params.id]
      );
      const cur = curRows[0];
      if (!cur) return null;
      await client.query(`update branches set operating_model = $2 where id = $1`, [cur.id, model]);
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "branch_model_changed",
        storeId: cur.store_id,
        branchId: cur.id,
        details: { branchName: cur.name, before: cur.operating_model, after: model },
      });
      return { id: cur.id, operatingModel: model };
    });
    if (!result) return res.status(404).json({ error: "branch_not_found" });
    res.json({ branch: result });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "branch_not_found" });
    next(err);
  }
});

// ═══════════════════════ حسابات المركزي للمتجر ═══════════════════════
//
// كلمات المرور مخزّنة bcrypt — لا تُقرأ ولا تُعرض أبدًا، حتى للأدمن. ما
// يُتاح هنا: رؤية البريد، تعديله، إضافة حساب مالك، وتعيين كلمة مرور جديدة
// تُعرض مرة واحدة لتُرسل للعميل.

function shapeStoreUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, createdAt: u.created_at };
}

/** POST /api/platform/stores/:id/users  { name, email, password } — حساب مالك جديد. */
router.post("/platform/stores/:id/users", async (req, res, next) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!name || !email) return res.status(400).json({ error: "name_and_email_required" });
  if (password.length < 8) return res.status(400).json({ error: "password_too_short" });
  try {
    const passwordHash = await hashPassword(password);
    const result = await inTx(async (client) => {
      const { rows: st } = await client.query(`select id from stores where id = $1`, [req.params.id]);
      if (!st[0]) return null;
      const { rows } = await client.query(
        `insert into store_users (store_id, name, email, password_hash, role)
         values ($1, $2, $3, $4, 'owner') returning *`,
        [req.params.id, name, email, passwordHash]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_user_created",
        storeId: req.params.id,
        details: { name, email },
      });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "store_not_found" });
    res.status(201).json({ storeUser: shapeStoreUser(result) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_used" });
    if (err.code === "22P02") return res.status(404).json({ error: "store_not_found" });
    next(err);
  }
});

/** PATCH /api/platform/store-users/:id  { name?, email? } */
router.patch("/platform/store-users/:id", async (req, res, next) => {
  const b = req.body || {};
  try {
    const result = await inTx(async (client) => {
      const { rows: cur } = await client.query(`select * from store_users where id = $1 for update`, [req.params.id]);
      const u = cur[0];
      if (!u) return { status: 404, body: { error: "store_user_not_found" } };
      const name = b.name !== undefined ? String(b.name).trim() : u.name;
      const email = b.email !== undefined ? String(b.email).trim() : u.email;
      if (!name || !email) return { status: 400, body: { error: "name_and_email_required" } };
      const { rows } = await client.query(
        `update store_users set name = $2, email = $3 where id = $1 returning *`,
        [u.id, name, email]
      );
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_user_updated",
        storeId: u.store_id,
        details: { before: { name: u.name, email: u.email }, after: { name, email } },
      });
      return { status: 200, body: { storeUser: shapeStoreUser(rows[0]) } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "email_already_used" });
    if (err.code === "22P02") return res.status(404).json({ error: "store_user_not_found" });
    next(err);
  }
});

/**
 * POST /api/platform/store-users/:id/password  { password }
 * كلمة مرور جديدة لحساب مركزي (العميل نسيها، أو تسليم أول مرة). القديمة
 * لا تُعرف ولا تُسترجع — تُستبدل فقط.
 */
router.post("/platform/store-users/:id/password", async (req, res, next) => {
  const password = String(req.body?.password || "");
  if (password.length < 8) return res.status(400).json({ error: "password_too_short" });
  try {
    const passwordHash = await hashPassword(password);
    const result = await inTx(async (client) => {
      const { rows } = await client.query(
        `update store_users set password_hash = $2 where id = $1 returning *`,
        [req.params.id, passwordHash]
      );
      if (!rows[0]) return null;
      await logAction(client, {
        adminId: req.platformAuth.adminId,
        action: "store_user_password_reset",
        storeId: rows[0].store_id,
        details: { email: rows[0].email },
      });
      return rows[0];
    });
    if (!result) return res.status(404).json({ error: "store_user_not_found" });
    res.json({ storeUser: shapeStoreUser(result) });
  } catch (err) {
    if (err.code === "22P02") return res.status(404).json({ error: "store_user_not_found" });
    next(err);
  }
});

/** GET /api/platform/log?storeId=&limit= — سجل العمليات، الأحدث أولًا. */
router.get("/platform/log", async (req, res, next) => {
  const limit = Math.min(2000, Math.max(1, toNonNegInt(req.query.limit) || 300));
  const storeId = req.query.storeId || null;
  try {
    const { rows } = await withoutBranch((c) =>
      c.query(
        `select l.id, l.action, l.details, l.created_at,
                l.store_id, s.name as store_name,
                l.branch_id, b.name as branch_name,
                a.name as admin_name
           from platform_log l
           left join stores s on s.id = l.store_id
           left join branches b on b.id = l.branch_id
           left join platform_admins a on a.id = l.admin_id
          where ($1::uuid is null or l.store_id = $1::uuid)
          order by l.created_at desc, l.id desc
          limit $2`,
        [storeId, limit]
      )
    );
    res.json({
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        details: r.details,
        createdAt: r.created_at,
        storeId: r.store_id,
        storeName: r.store_name,
        branchId: r.branch_id,
        branchName: r.branch_name,
        adminName: r.admin_name,
      })),
    });
  } catch (err) {
    if (err.code === "22P02") return res.status(400).json({ error: "invalid_store_id" });
    next(err);
  }
});

export default router;
