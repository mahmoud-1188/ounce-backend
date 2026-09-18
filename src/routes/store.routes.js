import { Router } from "express";
import crypto from "node:crypto";
import { withoutBranch } from "../db.js";
import { authenticateStore, requireStoreOwner } from "../middleware/storeAuth.js";
import { buildConsolidatedReport } from "../domain/consolidatedReport.js";
import { storeCanAddBranch } from "../domain/stores.js";
import { hashPin } from "../auth/hashPin.js";

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
router.post("/store/branches", requireStoreOwner, async (req, res, next) => {
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

export default router;
