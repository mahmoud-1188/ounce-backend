import { Router } from "express";
import crypto from "node:crypto";
import { withoutBranch, withBranch } from "../db.js";
import { authenticateStore, requireStoreOwner, requireCanManageBranches, requireCanSendCoding } from "../middleware/storeAuth.js";
import { buildConsolidatedReport } from "../domain/consolidatedReport.js";
import { buildAnalyticsReport } from "../domain/analyticsReport.js";
import { storeCanAddBranch } from "../domain/stores.js";
import { hashPassword } from "../auth/hashPassword.js";
import {
  loadBranchUsersWithRoles,
  createBranchUser,
  renameBranchUser,
  setBranchUserAi,
  setBranchUserPermissions,
  removeBranchUser,
  resetBranchUserPin,
  setBranchUserActive,
} from "../domain/branchUsers.js";
import { closeBusinessDay } from "../domain/businessDay.js";
import { applyMarkup, shapePolicy } from "../domain/pricePolicy.js";

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
        // ⚠ صحّة الفرع في بطاقته (المرجع: الإصدار · المستخدمون · اليوم · آخر بيع):
        //   تُقرأ من الجداول نفسها لا من لقطةٍ يرسلها الفرع — فلا تتأخّر.
        `select b.id, b.ref, b.name, b.is_hq, b.created_at, b.locked, b.lock_reason, b.locked_at, b.locked_by,
                (select count(*)::int from users u where u.branch_id = b.id and u.active = true) as users_count,
                (select max(s.date) from sales s where s.branch_id = b.id) as last_sale_at,
                (select d.ref from business_days d where d.branch_id = b.id and d.status = 'open'
                   order by d.opened_at desc limit 1) as open_day_ref,
                (select d.opened_at from business_days d where d.branch_id = b.id and d.status = 'open'
                   order by d.opened_at desc limit 1) as open_day_at
           from branches b
          where b.store_id = $1 and b.deleted_at is null
          order by b.name`,
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
        `select id, ref, name from branches where store_id = $1 and deleted_at is null order by name`,
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
        `select id, ref, name from branches where store_id = $1 and deleted_at is null order by name`,
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

      // ⚠ عبر createBranchUser المشتركة (لا INSERT يدوي منفصل كما كان
      // سابقًا) — نفس المسار الذي يستخدمه أي إنشاء موظفٍ آخر، فيحصل
      // مدير الفرع الجديد على ref فورًا مثل أي موظف (كان يبقى null هنا
      // تحديدًا قبل هذا الإصلاح، رغم أنه يُولَّد بشكل صحيح في كل مسار
      // إنشاء موظفٍ آخر). allowed_pages تبقى null ضمنيًّا داخل الدالة —
      // permissions.js يعتبرها "استخدم صلاحيات الدور الافتراضية"، فيحصل
      // المدير فورًا على كل صلاحيات دور manager الافتراضية، تمامًا كأي
      // manager يُنشأ من AccessSettingsPage داخل فرع قائم.
      const created = await createBranchUser(client, branch.id, {
        name: managerName.trim(),
        pin: managerPin,
        role: "manager",
        salary: 0,
      }, { name: req.storeAuth.name, kind: "store" });
      if (created.error) return { error: created.error };

      return { branch, manager: created.user };
    });

    if (result.error) return res.status(500).json({ error: result.error });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/store/branches/:branchId  { confirm }
 *
 * ⚠ تعطيل منطقي (soft-delete، migration 025_branches_soft_delete) لا
 * حذف فعلي: فرعٌ قد يحمل مبيعات/مخزون/محاسبة حقيقية، وحذفه فعليًّا من
 * الجدول كان سيفشل أصلًا (foreign keys من عشرات الجداول) أو سيحتاج
 * CASCADE يمحو تاريخًا ماليًا لا يُسترجع. بعد هذا التعطيل: الفرع يختفي
 * من كل قوائم/تقارير المتجر (راجع كل استعلامات deleted_at is null في
 * هذا الملف)، يُرفض تسجيل الدخول إليه فورًا (auth.routes.js + middleware/
 * auth.js)، ويتحرّر مكانه ضمن stores.max_branches لفرعٍ جديد
 * (storeCanAddBranch يستثني الفروع المحذوفة من العدّ).
 *
 * ⚠ confirm يجب أن يساوي "DELETE" حرفيًّا (بالإنجليزية، حالة الأحرف
 * كما هي) — تحقّقٌ من الخادم لا الواجهة وحدها، تمامًا لأن أي مسارٍ
 * هدّام (destructive) في هذا التطبيق لا يجب أن يعتمد على الفرونت إند
 * فقط لمنع ضغطة خاطئة (نفس مبدأ requirePage في الباك إند: ما يمنعه
 * الفرونت إند مجرّد راحة، الفحص الحقيقي هنا).
 *
 * requireCanManageBranches لا requireStoreOwner عمدًا — تمامًا كنظيرها
 * عند الإنشاء (POST /store/branches أعلاه): من يملك صلاحية إنشاء فرعٍ
 * يملك صلاحية حذفه منطقيًّا أيضًا، بلا تفريقٍ لم يُطلب.
 *
 * ⚠ الفرع الرئيسي (is_hq = true) لا يُحذف إطلاقًا: هو الفرع الوحيد الذي
 * يعتمد عليه مسار /api/hq/report القديم (راجع assertHqBranch في
 * hq.routes.js) — حذفه يكسر ذلك المسار كليًّا بلا أي بديل تلقائي.
 */
router.delete("/store/branches/:branchId", requireCanManageBranches, async (req, res, next) => {
  const { confirm } = req.body || {};
  if (confirm !== "DELETE") {
    return res.status(400).json({ error: "confirmation_required" });
  }
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, is_hq from branches where id = $1 and store_id = $2 and deleted_at is null`,
        [req.params.branchId, req.storeAuth.storeId]
      )
    );
    const branch = rows[0];
    if (!branch) return res.status(404).json({ error: "branch_not_found" });
    if (branch.is_hq) return res.status(403).json({ error: "cannot_delete_hq_branch" });

    await withoutBranch((client) =>
      client.query(`update branches set deleted_at = now() where id = $1`, [branch.id])
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/store/branches/:branchId/lock  { locked, reason }
 * قفل الفرع من الإدارة (migration 037): الفرع يرى شاشة قفلٍ بالسبب،
 * والخادم يرفض كل طلباته (423 branch_locked) حتى يُفكّ — يسري فورًا لأن
 * authenticate يقرأ القفل على كل طلب. القفل يحتاج سببًا يُقرأ في الفرع.
 */
router.patch("/store/branches/:branchId/lock", requireCanManageBranches, async (req, res, next) => {
  const locked = !!req.body?.locked;
  const reason = String(req.body?.reason || "").trim();
  if (locked && !reason) return res.status(400).json({ error: "lock_reason_required" });
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `update branches
            set locked = $1, lock_reason = $2, locked_at = case when $1 then now() else null end,
                locked_by = case when $1 then $3 else null end
          where id = $4 and store_id = $5 and deleted_at is null
          returning id, ref, name, is_hq, locked, lock_reason, locked_at, locked_by`,
        [locked, locked ? reason : null, req.storeAuth.name || null, req.params.branchId, req.storeAuth.storeId]
      )
    );
    if (!rows[0]) return res.status(404).json({ error: "branch_not_found" });
    res.json({ branch: rows[0] });
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
 * راجع migration 023_store_user_permissions.sql للسبب الكامل، وقرار
 * الإبقاء عليه رغم توسيع الشاشات المركزية في 026_store_user_coding_
 * permission.sql): كل موظفٍ مركزي له allowedPages (أي شاشات يراها) و
 * canManageBranches (هل يُنشئ فروعًا جديدة) و canSendCoding (هل يُرسل
 * تكويدًا فعليًّا لفرع) — أعلام مستقلة قابلة للتوسّع لاحقًا لنظام أدوار
 * حقيقي دون كسر البيانات القائمة، لا مجموعة ثابتة نهائيًّا.
 */

/** GET /api/store/users — موظفو المتجر المركزيون (owner فقط). */
router.get("/store/users", requireStoreOwner, async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select id, name, email, role, allowed_pages, can_manage_branches, can_send_coding, active, created_at
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
        canSendCoding: u.can_send_coding,
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
  const { name, email, password, allowedPages, canManageBranches, canSendCoding } = req.body || {};
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
        `insert into store_users (store_id, name, email, password_hash, role, allowed_pages, can_manage_branches, can_send_coding)
         values ($1, $2, $3, $4, 'staff', $5, $6, $7)
         returning id, name, email, role, allowed_pages, can_manage_branches, can_send_coding, active, created_at`,
        [
          req.storeAuth.storeId,
          String(name).trim(),
          String(email).trim(),
          passwordHash,
          allowedPages == null ? null : JSON.stringify(allowedPages),
          !!canManageBranches,
          !!canSendCoding,
        ]
      )
    );
    const u = rows[0];
    res.status(201).json({
      id: u.id, name: u.name, email: u.email, role: u.role,
      allowedPages: u.allowed_pages, canManageBranches: u.can_manage_branches, canSendCoding: u.can_send_coding,
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
  const { allowedPages, canManageBranches, canSendCoding, active } = req.body || {};
  if (allowedPages !== undefined && allowedPages !== null && !Array.isArray(allowedPages)) {
    return res.status(400).json({ error: "allowed_pages_must_be_array_or_null" });
  }
  try {
    const result = await withoutBranch(async (client) => {
      const { rows: targetRows } = await client.query(
        `select id, name, email, role, allowed_pages, can_manage_branches, can_send_coding, active, created_at
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
      if (canSendCoding !== undefined) {
        values.push(!!canSendCoding);
        sets.push(`can_send_coding = $${values.length}`);
      }
      if (active !== undefined) {
        values.push(!!active);
        sets.push(`active = $${values.length}`);
      }
      if (sets.length === 0) return { user: target };

      const { rows } = await client.query(
        `update store_users set ${sets.join(", ")}
         where id = $1 and store_id = $2
         returning id, name, email, role, allowed_pages, can_manage_branches, can_send_coding, active, created_at`,
        values
      );
      return { user: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: "store_user_not_found" });
    if (result.ownerLocked) return res.status(403).json({ error: "cannot_modify_owner" });

    const u = result.user;
    res.json({
      id: u.id, name: u.name, email: u.email, role: u.role,
      allowedPages: u.allowed_pages, canManageBranches: u.can_manage_branches, canSendCoding: u.can_send_coding,
      active: u.active, createdAt: u.created_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * إدارة مستخدمي فرعٍ بعينه عن بعد — نظير AccessSettingsPage.jsx تمامًا،
 * لكن من الإدارة المركزية لا من داخل الفرع نفسه (المنطق نفسه حرفيًّا،
 * مُستخرَجٌ في src/domain/branchUsers.js ومشترَك مع users.routes.js).
 *
 * ⚠ كل مسارٍ هنا يتحقق أولًا من أن الفرع فعلًا مملوكٌ لمتجر المستخدم
 * المركزي الحالي (assertBranchInStore) قبل أي عملية — بلا هذا الفحص
 * كان مستخدمٌ مركزي من متجرٍ سيستطيع إدارة مستخدمي فرعٍ من متجرٍ آخر
 * تمامًا بمجرد معرفة معرّف الفرع (تسريبٌ أمني حقيقي بين مستأجرَين).
 */
async function assertBranchInStore(storeId, branchId) {
  const { rows } = await withoutBranch((client) =>
    client.query(
      `select 1 from branches where id = $1 and store_id = $2 and deleted_at is null`,
      [branchId, storeId]
    )
  );
  return !!rows[0];
}

/** GET /api/store/branches/:branchId/users */
router.get("/store/branches/:branchId/users", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const users = await withBranch(req.params.branchId, (client) =>
      loadBranchUsersWithRoles(client, req.params.branchId)
    );
    // المعطَّلون أيضًا حين يُطلب (لإعادة تفعيلهم من الإدارة) — بلا صلاحيات محسوبة
    let inactive = [];
    if (req.query.includeInactive) {
      const { rows } = await withBranch(req.params.branchId, (client) =>
        client.query(
          `select id, name, ref, role, salary, can_use_ai, allowed_pages, active, created_at
             from users where branch_id = $1 and active = false order by name`,
          [req.params.branchId]
        )
      );
      inactive = rows.map((u) => ({ ...u, allowed: [] }));
    }
    res.json(
      [...users, ...inactive].map(({ id, name, ref, role, salary, can_use_ai, allowed_pages, allowed, active, created_at }) => ({
        id, name, ref, role, salary, can_use_ai, allowed_pages, allowed, active, created_at,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/** POST /api/store/branches/:branchId/users  { name, pin, role, salary } */
router.post("/store/branches/:branchId/users", requireCanManageBranches, async (req, res, next) => {
  const { name, pin, role, salary } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  if (!/^\d{4,6}$/.test(String(pin || ""))) {
    return res.status(400).json({ error: "pin_must_be_4_to_6_digits" });
  }
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      createBranchUser(client, req.params.branchId, { name, pin, role, salary }, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "invalid_role") return res.status(400).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(201).json(result.user);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/store/branches/:branchId/users/:id/rename  { name } */
router.patch("/store/branches/:branchId/users/:id/rename", requireCanManageBranches, async (req, res, next) => {
  const { name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: "name_required" });
  }
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      renameBranchUser(client, req.params.branchId, req.params.id, name, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result.user);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/store/branches/:branchId/users/:id/ai  { canUseAi } */
router.patch("/store/branches/:branchId/users/:id/ai", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      setBranchUserAi(client, req.params.branchId, req.params.id, req.body?.canUseAi, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    res.json(result.user);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/store/branches/:branchId/users/:id/permissions  { allowedPages } */
router.patch("/store/branches/:branchId/users/:id/permissions", requireCanManageBranches, async (req, res, next) => {
  const { allowedPages } = req.body || {};
  if (allowedPages !== null && !Array.isArray(allowedPages)) {
    return res.status(400).json({ error: "allowedPages_must_be_array_or_null" });
  }
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      setBranchUserPermissions(client, req.params.branchId, req.params.id, allowedPages, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json(result);
    res.json(result.user);
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/store/branches/:branchId/users/:id */
router.delete("/store/branches/:branchId/users/:id", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      removeBranchUser(client, req.params.branchId, req.params.id, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/store/branches/:branchId/users/:id/pin  { pin }
 * إعادة الرقم السري من الإدارة — لا يتكرّر في الفرع، ولا يُسجَّل الرقم.
 */
router.patch("/store/branches/:branchId/users/:id/pin", requireCanManageBranches, async (req, res, next) => {
  const pin = String(req.body?.pin || "");
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "pin_must_be_4_to_6_digits" });
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      resetBranchUserPin(client, req.params.branchId, req.params.id, pin, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** PATCH /api/store/branches/:branchId/users/:id/active  { active } — لا يُعطَّل آخر مدير */
router.patch("/store/branches/:branchId/users/:id/active", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const result = await withBranch(req.params.branchId, (client) =>
      setBranchUserActive(client, req.params.branchId, req.params.id, !!req.body?.active, { name: req.storeAuth.name, kind: "store" })
    );
    if (result.error === "not_found") return res.status(404).json({ error: result.error });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/store/branches/:branchId/close-day  { note }
 * إقفال يوم عمل الفرع من الإدارة — بالمعالج نفسه الذي يُقفل به الفرع يومه
 * (لقطةٌ واحدة لا لقطتان)، ويُدوَّن في سجل تدقيق الفرع باسم من أقفل.
 */
router.post("/store/branches/:branchId/close-day", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const by = req.storeAuth.name || "الإدارة";
    const extra = String(req.body?.note || "").trim();
    const result = await withBranch(req.params.branchId, async (client) => {
      const r = await closeBusinessDay(client, req.params.branchId, { closedBy: null, note: `إقفال من الإدارة — ${by}${extra ? ` · ${extra}` : ""}` });
      if (r.error) return r;
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',null,'business_days',$2,$3)`,
        [req.params.branchId, r.day.id, JSON.stringify({ kind: "close_day", by, byKind: "store", note: extra || null })]
      );
      return r;
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** GET /api/store/branches/:branchId/audit — آخر 200 حركة في سجل تدقيق الفرع */
router.get("/store/branches/:branchId/audit", requireCanManageBranches, async (req, res, next) => {
  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, req.params.branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const { rows } = await withBranch(req.params.branchId, (client) =>
      client.query(
        `select a.id, a.event_type, a.ref_table, a.details, a.created_at, u.name as actor_name
           from audit_log a left join users u on u.id = a.actor_id
          where a.branch_id = $1 order by a.created_at desc limit 200`,
        [req.params.branchId]
      )
    );
    res.json({ audit: rows.map((a) => ({
      id: a.id, event: a.event_type, table: a.ref_table, details: a.details || {},
      actor: a.actor_name || a.details?.by || "", date: a.created_at,
    })) });
  } catch (err) {
    next(err);
  }
});

// ══ زيادة الإدارة على السعر العالمي (migration 038) ═══════════════════
//
// سعر العمل في كل فروع المتجر = العالمي (آليًّا، أو يدويًّا تضبطه الإدارة)
// + زيادةٌ ثابتة (ريال/جم24 أو ٪). الفروع تستلمها مع كل جلبٍ للسعر.
router.get("/store/price-policy", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        "select price_markup_mode, price_markup_value, price_world24_manual, price_policy_at, price_policy_by from stores where id = $1",
        [req.storeAuth.storeId]
      )
    );
    res.json({ policy: shapePolicy(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.put("/store/price-policy", requireCanManageBranches, async (req, res, next) => {
  const b = req.body || {};
  const mode = b.mode === "percent" ? "percent" : "amount";
  const value = Number(b.value);
  const manual = b.world24Manual == null || b.world24Manual === "" ? null : Number(b.world24Manual);
  if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: "invalid_markup" });
  if (mode === "percent" && value > 100) return res.status(400).json({ error: "invalid_markup" });
  if (manual != null && !(manual > 0)) return res.status(400).json({ error: "invalid_world_price" });
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `update stores set price_markup_mode = $1, price_markup_value = $2, price_world24_manual = $3,
                price_policy_at = now(), price_policy_by = $4
          where id = $5
          returning price_markup_mode, price_markup_value, price_world24_manual, price_policy_at, price_policy_by`,
        [mode, value, manual, req.storeAuth.name || "الإدارة", req.storeAuth.storeId]
      )
    );
    const policy = shapePolicy(rows[0]);
    res.json({ policy, example: manual ? { world24: manual, price24: applyMarkup(manual, policy.markup) } : null });
  } catch (err) {
    next(err);
  }
});

// ══ إعلانات الإدارة لكل الفروع ══════════════════════════════════════════
router.get("/store/notices", async (req, res, next) => {
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        "select id, text, created_by, created_at, until from store_notices where store_id = $1 and until > now() order by created_at desc limit 50",
        [req.storeAuth.storeId]
      )
    );
    res.json({ notices: rows.map((n) => ({ id: n.id, text: n.text, by: n.created_by, at: n.created_at, until: n.until })) });
  } catch (err) {
    next(err);
  }
});

router.post("/store/notices", requireCanManageBranches, async (req, res, next) => {
  const text = String(req.body?.text || "").trim();
  const days = Math.max(1, Math.min(90, Math.round(Number(req.body?.days) || 7)));
  if (!text) return res.status(400).json({ error: "notice_text_required" });
  if (text.length > 500) return res.status(400).json({ error: "notice_too_long" });
  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `insert into store_notices (store_id, text, created_by, until)
         values ($1,$2,$3, now() + ($4 || ' days')::interval)
         returning id, text, created_by, created_at, until`,
        [req.storeAuth.storeId, text, req.storeAuth.name || "الإدارة", String(days)]
      )
    );
    const n = rows[0];
    res.status(201).json({ notice: { id: n.id, text: n.text, by: n.created_by, at: n.created_at, until: n.until } });
  } catch (err) {
    next(err);
  }
});

router.delete("/store/notices/:id", requireCanManageBranches, async (req, res, next) => {
  try {
    await withoutBranch((client) =>
      client.query("delete from store_notices where id = $1 and store_id = $2", [req.params.id, req.storeAuth.storeId])
    );
    res.status(204).end();
  } catch (err) {
    if (err && err.code === "22P02") return res.status(404).json({ error: "not_found" });
    next(err);
  }
});

export default router;
