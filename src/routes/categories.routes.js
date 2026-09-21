import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { normalizeName } from "../auth/normalizeName.js";

const router = Router();

router.use("/categories", authenticate, requirePage("categories"), requireNotDenied("categories"));

const SALE_MODES = ["whole", "partial", "set"];

/**
 * POST /api/categories/reconcile — الشاشة (CategoriesPage.jsx) لا ترسل
 * حدثًا واحدًا (أضِف/عدِّل/احذف) بل مصفوفة list كاملة تمثّل الحالة
 * النهائية المطلوبة (إضافات وتعديلات وحذف وإعادة ترتيب كلها مطويّة في
 * كائن واحد) — نظير هذا الشكل بالضبط، لا نمط create/update المنفصل
 * المستخدم في باقي هذا الملف (createSupplier، إلخ)، لأن onSave نفسه في
 * الشاشة يُستدعى مرة واحدة بكامل القائمة بعد "حفظ التغييرات".
 *
 * ⚠ فجوة حقيقية أُغلقت هنا بالكامل: لم يكن هناك أي مسار خلفي لهذه الشاشة
 * إطلاقًا (categories في bootstrap للقراءة فقط) — كل تعديل هنا كان يظهر
 * محليًا فقط (window.storage) ويختفي عند إعادة التحميل. راجع أيضًا
 * migration 029_categories_write.sql لإصلاح RLS ذي الصلة (صفوف
 * "مشتركة" branch_id=null كانت محجوبة بصمت عن كل استعلام قبل هذه
 * الهجرة، بصرف النظر عمّا يطلبه استعلام الكود).
 *
 * body: { categories: [{ id, label, saleMode, minSaleWeight? }] }
 * — id يبدأ بـ"cat_" (توليد الشاشة المحلي القديم slug()) يعني تصنيفًا
 * جديدًا لم يُدرج بعد؛ id على شكل UUID حقيقي يعني تصنيفًا موجودًا
 * (تعديل أو إبقاء)، وأي id حقيقي موجود في القاعدة ولم يرد في القائمة
 * يعني حذفًا مطلوبًا (يُرفض إن كان لا يزال مستخدَمًا في items — نفس
 * فحص inUse في الشاشة، لكن هنا فحصٌ حقيقي على حقيقة القاعدة، لا على
 * الحالة المحلية التي قد تكون قديمة).
 *
 * الاستجابة: { categories: [...] } بأشكال UUID حقيقية لكل صف (بما فيها
 * ما كان معرّفه المحلي cat_*) — الشاشة تستبدل قائمتها المحلية بهذه
 * القائمة، فلا يبقى أي id مؤقت بعد نجاح الحفظ.
 */
router.post("/categories/reconcile", async (req, res, next) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.categories) ? body.categories : [];

  for (const c of incoming) {
    if (!String(c.label || "").trim()) return res.status(400).json({ error: "missing_field", field: "label", fieldLabel: "الاسم" });
    if (!SALE_MODES.includes(c.saleMode)) return res.status(400).json({ error: "invalid_sale_mode" });
  }

  // تكرار الاسم داخل القائمة المُرسَلة نفسها (بعد التطبيع) — نفس فحص
  // الشاشة (normalizeName(c.label) === normalizeName(label)) لكن على
  // كامل القائمة دفعة واحدة.
  const seen = new Set();
  for (const c of incoming) {
    const n = normalizeName(c.label);
    if (seen.has(n)) return res.status(409).json({ error: "duplicate_label", label: c.label });
    seen.add(n);
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: existingRows } = await client.query(
        `select id, branch_id from categories where branch_id = $1 or branch_id is null`,
        [req.auth.branchId]
      );
      const existingIds = new Set(existingRows.map((r) => r.id));
      const incomingRealIds = new Set(
        incoming.filter((c) => existingIds.has(c.id)).map((c) => c.id)
      );

      // ── حذف: موجود في القاعدة وغائب عن القائمة المُرسَلة ──
      const toDelete = existingRows.filter((r) => !incomingRealIds.has(r.id));
      for (const row of toDelete) {
        // ⚠ لا حذف تصنيف مشترك (branch_id=null) من فرع واحد: قد يستخدمه
        // فرع آخر لا تراه هذه الجلسة إطلاقًا (RLS يقصر رؤيتنا على هذا
        // الفرع + المشترك، لا كل الفروع) — تركه غير مذكور في القائمة
        // يعني غالبًا أن الشاشة لم تكن تعرضه أصلًا لهذا المستخدم بسبب
        // مصدره القديم، لا أن حذفه مقصود فعليًا.
        if (row.branch_id === null) continue;
        const { rows: usedRows } = await client.query(
          `select 1 from items where category_id = $1 and branch_id = $2 limit 1`,
          [row.id, req.auth.branchId]
        );
        if (usedRows[0]) return { error: "category_in_use", categoryId: row.id };
        await client.query(`delete from categories where id = $1 and branch_id = $2`, [row.id, req.auth.branchId]);
      }

      // ── إضافة/تعديل، بترتيب القائمة المُرسَلة (sort_order) ──
      const finalCategories = [];
      for (let i = 0; i < incoming.length; i++) {
        const c = incoming[i];
        const minSaleWeight = c.saleMode === "partial" && Number(c.minSaleWeight) > 0 ? Number(c.minSaleWeight) : null;

        if (existingIds.has(c.id)) {
          // ⚠ لا تعديل لصفٍّ مشترك (branch_id=null) من فرع واحد بلا علم
          // بقية الفروع — يُقبل هنا فقط تحديث الحقول المحلية المسموح
          // بها بلا تغيير ملكيته (branch_id يبقى كما هو دائمًا).
          const { rows: updRows } = await client.query(
            `update categories set name = $1, sale_mode = $2, min_sale_weight = $3, sort_order = $4
             where id = $5 and (branch_id = $6 or branch_id is null)
             returning id, branch_id, name, sale_mode, min_sale_weight, sort_order`,
            [c.label.trim(), c.saleMode, minSaleWeight, i, c.id, req.auth.branchId]
          );
          if (updRows[0]) finalCategories.push(updRows[0]);
        } else {
          // معرّف محلي قديم (cat_*) أو أي شيء آخر غير موجود فعليًا —
          // إدراج حقيقي جديد بمعرّف UUID من القاعدة، دائمًا لهذا الفرع
          // (لا صفوف مشتركة جديدة من شاشة فرع واحد).
          const { rows: insRows } = await client.query(
            `insert into categories (branch_id, name, sale_mode, min_sale_weight, sort_order)
             values ($1,$2,$3,$4,$5)
             returning id, branch_id, name, sale_mode, min_sale_weight, sort_order`,
            [req.auth.branchId, c.label.trim(), c.saleMode, minSaleWeight, i]
          );
          finalCategories.push(insRows[0]);
        }
      }

      return { categories: finalCategories };
    });

    if (result.error) {
      const status = result.error === "category_in_use" ? 409 : 400;
      return res.status(status).json(result);
    }
    res.json({
      categories: result.categories.map((c) => ({
        id: c.id,
        label: c.name,
        saleMode: c.sale_mode,
        minSaleWeight: c.min_sale_weight == null ? null : Number(c.min_sale_weight),
      })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
