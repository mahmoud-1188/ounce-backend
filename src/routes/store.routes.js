import { Router } from "express";
import crypto from "node:crypto";
import { withoutBranch } from "../db.js";
import { authenticateStore, requireStoreOwner, requireCanManageBranches } from "../middleware/storeAuth.js";
import { buildConsolidatedReport } from "../domain/consolidatedReport.js";
import { buildAnalyticsReport } from "../domain/analyticsReport.js";
import { storeCanAddBranch } from "../domain/stores.js";
import { hashPin } from "../auth/hashPin.js";
import { hashPassword } from "../auth/hashPassword.js";

const router = Router();

/**
 * مسارات المستخدم المركزي (store_users) — النقطة ⑥ من خطة تعدّد
 * المتاجر: تعرض للمستخدم المركزي فروع متجره فقط، وتقريرًا مجمّعًا لها،
 * وتتيح إنشاء فرع جديد ضمن سقف الاشتراك (storeCanAddBranch).
 *
 * ⚠ كل هذه المسارات تمرّ عبر withoutBranch عمدًا (لا يوجد app.current_
 * branch_id في جلسة المستخدم المركزي أصلًا — هو ليس مستخدم فرع)، وكل
 * استعلام هنا مقيّد يدويًّا بـstore_id من req.storeAuth، تمامًا كنمط
 * assertHqBranch في hq.routes.js.
 */
router.use("/store", authenticateStore);

/** GET /api/store/branches — فروع المتجر الحالي فقط. */
router.get("/store/branches", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, ref, name, is_hq, created_at
           from branches
          where store_id = $1
          order by name`,
        [req.storeAuth.storeId]
      )
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/store/report?period=YYYY-MM
 * نفس منطق /api/hq/report القديم تمامًا (راجع src/domain/consolidatedReport.js)
 * لكن مقيّدًا بجلسة مستخدم مركزي حقيقية بدل فرع مُعلَّم is_hq يدويًّا.
 */
router.get("/store/report", async (req, res, next) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period || "")
      ? req.query.period
      : new Date().toISOString().slice(0, 7);
    const periodStart = `${period}-01`;

    const report = await withoutBranch(async (client) => {
      const { rows: branches } = await client.query(
        `select id, ref, name from branches where store_id = $1 order by name`,
        [req.storeAuth.storeId]
      );
      if (!branches.length) return { period, branches: [] };

      const { branches: rows, totals } = await buildConsolidatedReport(client, branches, periodStart);
      return { period, branches: rows, totals };
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/store/analytics?period=YYYY-MM
 * نظير HqAnalytics.js في المرجع — ترتيب الفروع بمقاييس متعددة (نمو،
 * دوران مخزون، مبيعات لكل موظف)، توزيع طرق الدفع، وتوزيع المخزون
 * بالعيار، وأعلى البائعين. راجع src/domain/analyticsReport.js.
 */
router.get("/store/analytics", async (req, res, next) => {
  try {
    const period = /^\d{4}-\d{2}$/.test(req.query.period || "")
      ? req.query.period
      : new Date().toISOString().slice(0, 7);
    const periodStart = `${period}-01`;

    const report = await withoutBranch(async (client) => {
      const { rows: branches } = await client.query(
        `select id, ref, name from branches where store_id = $1 order by name`,
        [req.storeAuth.storeId]
      );
      if (!branches.length) return { period, branches: [], byMethod: [], byKarat: [], topSellers: [] };

      const analytics = await buildAnalyticsReport(client, branches, periodStart);
      return { period, ...analytics };
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/store/branches  { name, managerName, managerPin }
 * ينشئ فرعًا جديدًا لمتجر المستخدم المركزي الحالي، بشرط عدم تجاوز سقف
 * الاشتراك (storeCanAddBranch) — وينشئ معه أول مستخدم manager للفرع
 * الجديد فورًا (بلا هذا المستخدم، الفرع يُنشأ بلا أي طريقة دخول إليه من
 * تطبيق الفرع أصلًا). owner فقط (requireStoreOwner) — إنشاء فرع قرار
 * تجاري لا يُترك لموظف مركزي عادي (لا يوجد دور "staff" آخر بعد بأي حال).
 *
 * ⚠ ref الفرع: لا يوجد أي نمط توليد ref سابق لجدول branches نفسه في هذا
 * الباك إند (الفروع القائمة أُنشئت يدويًّا لا عبر مسار API) — فبدل تخمين
 * تسلسل رقمي لكل متجر (يحتاج جدول عدّاد إضافي)، نولّد رمزًا عشوائيًا
 * قصيرًا ونتحقق من تفرّده، بنفس ضمان unique الذي يفرضه schema.sql أصلًا.
 */
// ⚠ requireCanManageBranches لا requireStoreOwner: موظفٌ مركزي مُصرَّح
// له صراحةً بإدارة الفروع (can_manage_branches) يستطيع إنشاء فرعٍ جديد
// أيضًا الآن — راجع migration 023_store_user_permissions.sql.
router.post("/store/branches", requireCanManageBranches, async (req, res, next) => {
  const { name, managerName, managerPin } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  if (!managerName || !String(managerName).trim()) {
    return res.status(400).json({ error: "manager_name_required" });
  }
  if (!/^\d{4,6}$/.test(String(managerPin || ""))) {
    return res.status(400).json({ error: "manager_pin_must_be_4_to_6_digits" });
  }

  try {
    const gate = await storeCanAddBranch(req.storeAuth.storeId);
    if (!gate.ok) {
      return res.status(403).json({
        error: gate.reason,
        branchCount: gate.branchCount,
        maxBranches: gate.maxBranches,
      });
    }

    const pinHash = await hashPin(managerPin);

    const result = await withoutBranch(async (client) => {
      let ref;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = `BR-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const { rows: existing } = await client.query(
          "select 1 from branches where ref = $1",
          [candidate]
        );
        if (!existing.length) {
          ref = candidate;
          break;
        }
      }
      if (!ref) return { error: "ref_generation_failed" };

      const { rows: branchRows } = await client.query(
        `insert into branches (store_id, ref, name)
         values ($1, $2, $3)
         returning id, ref, name, is_hq, created_at`,
        [req.storeAuth.storeId, ref, name.trim()]
      );
      const branch = branchRows[0];

      // ⚠ allowed_pages = null عمدًا (لا مصفوفة فارغة): permissions.js
      // يعتبر null "استخدم صلاحيات الدور الافتراضية" — manager الجديد
      // يحصل فورًا على كل صلاحيات دور manager الافتراضية، تمامًا كأي
      // manager يُنشأ من AccessSettingsPage داخل فرع قائم.
      const { rows: userRows } = await client.query(
        `insert into users (branch_id, name, role, pin_hash)
         values ($1, $2, 'manager', $3)
         returning id, name, role, created_at`,
        [branch.id, managerName.trim(), pinHash]
      );

      return { branch, manager: userRows[0] };
    });

    if (result.error) return res.status(500).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * إدارة موظفي المركزي (store_users) — نظير AccessSettingsPage.jsx في
 * ounce-frontend، لكن للمستخدم المركزي: owner فقط (requireStoreOwner
 * صراحةً لا requireCanManageBranches — إدارة من يملك الوصول أصلًا قرارٌ
 * أضيق من إدارة الفروع، لا يُترك حتى لموظفٍ يملك صلاحية إدارة الفروع).
 *
 * ⚠ صلاحيات مبسّطة عمدًا (لا نظام أدوار متعدّدة/فصل مهام كالمرجع —
 * راجع migration 023_store_user_permissions.sql للسبب الكامل): كل
 * موظفٍ مركزي له allowedPages (أي شاشات من الأربع الحالية يراها) و
 * canManageBranches (هل يُنشئ فروعًا جديدة) فقط.
 */

/** GET /api/store/users — موظفو المتجر المركزيون (owner فقط). */
router.get("/store/users", requireStoreOwner, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, name, email, role, allowed_pages, can_manage_branches, active, created_at
           from store_users
          where store_id = $1
          order by created_at`,
        [req.storeAuth.storeId]
      )
    );
    res.json(
      rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        allowedPages: u.allowed_pages,
        canManageBranches: u.can_manage_branches,
        active: u.active,
        createdAt: u.created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/store/users  { name, email, password, allowedPages?, canManageBranches? }
 * ينشئ موظفًا مركزيًّا جديدًا بدور staff دائمًا (owner لا يُنشأ إلا عبر
 * bootstrap-owner — راجع storeAuth.routes.js). allowedPages: مصفوفة
 * أسماء شاشات أو null (بلا قيد — نادرًا ما يُستخدم لـstaff، لكن نفس
 * الاتفاقية أينما ظهرت).
 */
router.post("/store/users", requireStoreOwner, async (req, res, next) => {
  const { name, email, password, allowedPages, canManageBranches } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  if (!email || !String(email).trim()) {
    return res.status(400).json({ error: "email_required" });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: "password_too_short" });
  }
  if (allowedPages !== undefined && allowedPages !== null && !Array.isArray(allowedPages)) {
    return res.status(400).json({ error: "allowed_pages_must_be_array_or_null" });
  }

  try {
    const passwordHash = await hashPassword(password);
    const { rows } = await withoutBranch((client) =>
      client.query(
        `insert into store_users (store_id, name, email, password_hash, role, allowed_pages, can_manage_branches)
         values ($1, $2, $3, $4, 'staff', $5, $6)
         returning id, name, email, role, allowed_pages, can_manage_branches, active, created_at`,
        [
          req.storeAuth.storeId,
          String(name).trim(),
          String(email).trim(),
          passwordHash,
          allowedPages == null ? null : JSON.stringify(allowedPages),
          !!canManageBranches,
        ]
      )
    );
    const u = rows[0];
    res.status(201).json({
      id: u.id, name: u.name, email: u.email, role: u.role,
      allowedPages: u.allowed_pages, canManageBranches: u.can_manage_branches,
      active: u.active, createdAt: u.created_at,
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "email_already_used" });
    }
    next(err);
  }
});

/**
 * PATCH /api/store/users/:id  { allowedPages?, canManageBranches?, active? }
 * يعدّل صلاحيات موظفٍ مركزي قائم — لا owner (لا يجوز لأي owner أن يقيّد
 * owner آخر أو نفسه من هنا؛ حراسةٌ بسيطة ضد قفل الحساب الوحيد بالخطأ).
 */
router.patch("/store/users/:id", requireStoreOwner, async (req, res, next) => {
  const { allowedPages, canManageBranches, active } = req.body || {};
  if (allowedPages !== undefined && allowedPages !== null && !Array.isArray(allowedPages)) {
    return res.status(400).json({ error: "allowed_pages_must_be_array_or_null" });
  }
  try {
    const result = await withoutBranch(async (client) => {
      const { rows: targetRows } = await client.query(
        `select id, name, email, role, allowed_pages, can_manage_branches, active, created_at
           from store_users where id = $1 and store_id = $2`,
        [req.params.id, req.storeAuth.storeId]
      );
      const target = targetRows[0];
      if (!target) return { notFound: true };
      if (target.role === "owner") return { ownerLocked: true };

      // ⚠ لا coalesce($n, old_value) هنا: allowedPages = null قصدًا
      // ("بلا قيد") قيمةٌ صالحة يجب أن تُكتب فعليًّا، وcoalesce كانت
      // ستُبقي القديمة دائمًا كلما أرسل الطالب null — يمنع owner من
      // إزالة قيد staff نهائيًّا مطلقًا. نبني SET ديناميكيًّا بدل ذلك:
      // فقط الحقول المُرسَلة فعليًّا (!== undefined) تُحدَّث.
      const sets = [];
      const values = [req.params.id, req.storeAuth.storeId];
      if (allowedPages !== undefined) {
        values.push(allowedPages === null ? null : JSON.stringify(allowedPages));
        sets.push(`allowed_pages = $${values.length}`);
      }
      if (canManageBranches !== undefined) {
        values.push(!!canManageBranches);
        sets.push(`can_manage_branches = $${values.length}`);
      }
      if (active !== undefined) {
        values.push(!!active);
        sets.push(`active = $${values.length}`);
      }
      if (sets.length === 0) return { user: target };

      const { rows } = await client.query(
        `update store_users set ${sets.join(", ")}
         where id = $1 and store_id = $2
         returning id, name, email, role, allowed_pages, can_manage_branches, active, created_at`,
        values
      );
      return { user: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: "store_user_not_found" });
    if (result.ownerLocked) return res.status(403).json({ error: "cannot_modify_owner" });

    const u = result.user;
    res.json({
      id: u.id, name: u.name, email: u.email, role: u.role,
      allowedPages: u.allowed_pages, canManageBranches: u.can_manage_branches,
      active: u.active, createdAt: u.created_at,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
