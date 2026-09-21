import { Router } from "express";
import { withoutBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import { buildConsolidatedReport } from "../domain/consolidatedReport.js";

const router = Router();

/**
 * تقرير "الإدارة/متعدد الفروع" — migration 017.
 *
 * ⚠ ميزة جديدة فعليًا، لا تفعيل سقالة ميتة بالمعنى المعتاد (قارن بـ015/
 * 016): hq_permissions/branches.is_hq موجودان في schema.sql لكن
 * HqTransactionsPage.js المرجعي شيء آخر تمامًا — مزامنة يدوية بين نسخ
 * محلية منفصلة عبر رمز موقَّع يُلصق ويُرسَل واتساب (لا خادم مشترك في
 * المرجع أصلًا). تطبيقنا يملك قاعدة بيانات واحدة حقيقية تخدم كل الفروع
 * فعليًا، فالمعنى العملي لـ"تقرير الإدارة" هنا هو تجميع مباشر من نفس
 * القاعدة عبر SQL، لا محاكاة مزامنة الرموز.
 *
 * القرار (سؤال المستخدم صراحةً — راجع محادثة إضافة هذا الملف):
 *   • من يرى التقرير؟ فرع واحد فقط مُعلَّم branches.is_hq = true (عملية
 *     تشغيلية تُجرى يدويًّا على القاعدة، لا واجهة تمنحها) — أي مستخدم
 *     manager في ذلك الفرع تحديدًا. هذا التحقق يجري هنا صراحةً (لا يكفي
 *     requirePage وحده) لأن withoutBranch أدناه يتجاوز عزل RLS عمدًا.
 *   • ما النطاق؟ ملخصات مجمّعة فقط لكل فرع — بلا تفاصيل سجلات فردية.
 *
 * ⚠ withoutBranch هو المسار الوحيد في كل الباك إند الذي يتجاوز عزل
 * الفروع عمدًا. حمايته الوحيدة هي فحص is_hq يدويًّا أدناه قبل أي استعلام
 * — أي تعديل هنا يجب أن يُبقي هذا الفحص أول خطوة دائمًا.
 */
router.use("/hq", authenticate, requirePage("hqReports"));

async function assertHqBranch(req) {
  const { rows } = await withoutBranch((client) =>
    client.query(`select is_hq, store_id from branches where id = $1`, [req.auth.branchId])
  );
  const row = rows[0];
  // ⚠ إصلاح فجوة عزل حقيقية (migration 020_stores_multi_tenant.sql):
  // قبل stores كانت كل الفروع في القاعدة لمتجر واحد ضمنيًا، فكان
  // `select ... from branches` بلا فلتر آمنًا. الآن مع تعدّد المتاجر
  // (multi-tenant)، ذاك الاستعلام كان سيرجع فروع كل المتاجر — تسريب مالي
  // حقيقي بين متجر وآخر. لذا يُرجع store_id الآن مع نتيجة الفحص، ليستخدمه
  // المستدعي لقصر قائمة الفروع على متجره فقط.
  return { isHq: !!row?.is_hq, storeId: row?.store_id || null };
}

/**
 * GET /api/hq/report?period=YYYY-MM
 *
 * period اختياري (افتراضه الشهر الحالي) ويحدّد فقط نافذة المبيعات/
 * المشتريات (تدفّق)؛ أرصدة المخزون/الخزنة/الذمم أرقام "حتى الآن" (رصيد)
 * لا فرق فيها للفترة — تمامًا كيف تُعرض كل شاشة رصيد أخرى في التطبيق
 * (خزنة، مخزون) بلا فلترة بفترة.
 */
router.get("/hq/report", async (req, res, next) => {
  try {
    const { isHq, storeId } = await assertHqBranch(req);
    if (!isHq) {
      return res.status(403).json({ error: "not_hq_branch" });
    }

    const period = /^\d{4}-\d{2}$/.test(req.query.period || "")
      ? req.query.period
      : new Date().toISOString().slice(0, 7);
    const periodStart = `${period}-01`;

    const report = await withoutBranch(async (client) => {
      // ⚠ مقيّد بstore_id عمدًا — بلاه هذا الاستعلام كان سيرجّع فروع
      // كل المتاجر معًا في تقرير إدارة متجر واحد — تسريب مالي حقيقي
      // بين متجرين منفصلين تمامًا (مراجع assertHqBranch أعلاه).
      const { rows: branches } = await client.query(
        `select id, ref, name from branches where store_id = $1 and deleted_at is null order by name`,
        [storeId]
      );
      if (!branches.length) return { period, branches: [] };

      // ⚠ منطق التجميع نفسه مُستخرَج إلى src/domain/consolidatedReport.js
      // ليشترك فيه هذا المسار (القديم، فرع is_hq واحد) ومسار
      // /api/store/report (الجديد، جلسة مستخدم مركزي) دون تكرار.
      const { branches: rows, totals } = await buildConsolidatedReport(client, branches, periodStart);

      return { period, branches: rows, totals };
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
