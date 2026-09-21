import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";

const router = Router();

router.use("/lots", authenticate, requirePage("addGoods"), requireNotDenied("addGoods"));

const KARATS = [24, 22, 21, 18, 14];
const PURITY = { 24: 1, 22: 22 / 24, 21: 21 / 24, 18: 18 / 24, 14: 14 / 24 };

/**
 * POST /api/lots/:id/items — إضافة أصناف مُكوَّدة جديدة لدفعة (lot)
 * مفتوحة — المسار الخلفي الحقيقي المفقود لـhandleAddItems في
 * GoldInventoryApp.jsx (راجع تعليق migration 028_lot_item_coding.sql
 * للسياق الكامل). نظير AddGoodsPage.jsx/handleAddItems بالضبط، لكن يكتب
 * items/item_units حقيقيين بدل window.storage.
 *
 * ⚠ بلا أي قيد وزن جديد في gold_ledger_entries: وزن الدفعة دخل حساب 1210
 * بالفعل عند تسجيل الشراء نفسه (purchases.routes.js، سطر "دفتر الوزن").
 * التكويد هنا هو فهرسة/تقطيع فقط (كم قطعة، أي تصنيف، أي أجرة لكل قطعة)
 * لوزنٍ داخل 1210 أصلًا — لا إعادة تصنيف حساب كتحويل الكسر (1230→1210)
 * ولا قيمة جديدة تدخل الدفاتر. يطابق تمامًا غياب أي postWeight إضافي في
 * دالة التكويد المقابلة بالمرجع (خلافًا لـhandleReceiveShipment وتحويل
 * الكسر، وكلاهما ينقل وزنًا بين حسابين فعليًا).
 *
 * body: { rows: [{ categoryId, weight, stonesWeight?, quantity?,
 *                   costPerGram?, workmanshipPerUnit?, isSet?, setPieces? }],
 *         distributionMode?: "per_gram" | "per_item" | "by_karat" }
 *
 * الأجرة: كل صف يحمل workmanshipPerUnit يدويًّا (كما تُدخله الشاشة)، ثم
 * يُضاف له نصيبه من workmanship_total المتبقي للدفعة (workmanship_total -
 * workmanship_allocated) موزَّعًا بنفس منطق شاشة AddGoodsPage.jsx بالضبط
 * (per_gram: بالوزن الكلي للصف، per_item: بعدد القطع، by_karat: بالوزن
 * الخالص). المتبقي محسوبٌ من عمود workmanship_allocated الحقيقي (لا من
 * قيمة NaN كانت تُقرأ محليًا من حقل لا وجود له في قاعدة البيانات) — هذا
 * بالضبط ما يمنع ازدواج الأجرة عند التكويد على دفعات من نفس lot.
 */
router.post("/lots/:id/items", async (req, res, next) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const distributionMode = ["per_gram", "per_item", "by_karat"].includes(body.distributionMode)
    ? body.distributionMode
    : "per_gram";

  if (!rows.length) return res.status(400).json({ error: "no_rows" });
  for (const r of rows) {
    if (!(Number(r.weight) > 0)) return res.status(400).json({ error: "missing_field", field: "weight", fieldLabel: "الوزن" });
    if (!r.categoryId) return res.status(400).json({ error: "missing_field", field: "categoryId", fieldLabel: "التصنيف" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: lotRows } = await client.query(
        "select * from lots where id = $1 and branch_id = $2 for update",
        [req.params.id, req.auth.branchId]
      );
      const lot = lotRows[0];
      if (!lot) return { error: "lot_not_found" };
      if (lot.status !== "open") return { error: "lot_not_open" };
      if (!KARATS.includes(Number(lot.karat))) return { error: "lot_missing_karat" };

      // تحقق التصنيفات كلها دفعة واحدة قبل أي إدراج.
      const categoryIds = [...new Set(rows.map((r) => r.categoryId))];
      const { rows: catRows } = await client.query(
        `select id from categories where branch_id = $1 or branch_id is null`,
        [req.auth.branchId]
      );
      const validCategoryIds = new Set(catRows.map((c) => c.id));
      for (const cid of categoryIds) {
        if (!validCategoryIds.has(cid)) return { error: "category_not_found" };
      }

      // ⚠ يوم العمل الحالي المفتوح، لا يوم الشراء الأصلي للدفعة: التكويد
      // قد يحدث في يومٍ لاحق تمامًا عن يوم تسجيل الشراء (نفس الفارق بين
      // lot.business_day_id وقت الشراء وbusinessDayId هنا وقت التكويد).
      const { rows: dayRows } = await client.query(
        `select id from business_days where branch_id = $1 and status = 'open'
           order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDayId = dayRows[0]?.id || null;

      const karat = Number(lot.karat);
      const rowQty = (r) => Math.max(1, Number(r.quantity) || 1);
      const rowWeightQty = (r) => Number(r.weight) * rowQty(r);
      const rowFine = (r) => rowWeightQty(r) * (PURITY[karat] || karat / 24);

      const remainingWorkmanship = Math.max(
        0,
        Number(lot.workmanship_total) - Number(lot.workmanship_allocated)
      );
      let denom = 0;
      if (remainingWorkmanship > 0) {
        if (distributionMode === "per_item") denom = rows.reduce((a, r) => a + rowQty(r), 0);
        else if (distributionMode === "by_karat") denom = rows.reduce((a, r) => a + rowFine(r), 0);
        else denom = rows.reduce((a, r) => a + rowWeightQty(r), 0);
      }
      const shareForRow = (r) => {
        if (remainingWorkmanship <= 0 || denom <= 0) return 0;
        const numer = distributionMode === "per_item" ? rowQty(r) : distributionMode === "by_karat" ? rowFine(r) : rowWeightQty(r);
        return (remainingWorkmanship * numer) / denom / rowQty(r); // نصيب الوحدة الواحدة
      };

      const { rows: refCountRows } = await client.query(
        `select count(*)::int as n from items where branch_id = $1`,
        [req.auth.branchId]
      );
      let nextRefNum = refCountRows[0].n + 1;

      const createdItems = [];
      let allocatedNow = 0;

      for (const row of rows) {
        const quantity = rowQty(row);
        const allocatedWorkmanship = shareForRow(row);
        const totalWorkmanship = (Number(row.workmanshipPerUnit) || 0) + allocatedWorkmanship;
        const costPerGram = row.costPerGram != null ? Number(row.costPerGram) : Number(lot.cost_per_gram) || null;
        const ref = `ITM-${String(nextRefNum++).padStart(6, "0")}`;

        const { rows: itemRows } = await client.query(
          `insert into items
             (branch_id, ref, lot_id, category_id, karat, weight, stones_weight,
              cost_per_gram, workmanship, lot_workmanship_share, from_scrap,
              business_day_id, created_by)
           values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,false, $11,$12)
           returning id, ref, karat, weight, stones_weight, cost_per_gram,
                     workmanship, lot_workmanship_share, date_added`,
          [
            req.auth.branchId, ref, lot.id, row.categoryId, karat,
            Number(row.weight), Number(row.stonesWeight) || 0,
            costPerGram, totalWorkmanship, allocatedWorkmanship,
            businessDayId, req.auth.userId,
          ]
        );
        const newItem = itemRows[0];

        const units = [];
        for (let i = 0; i < quantity; i++) {
          const code = quantity > 1 ? `${ref}-${i + 1}` : ref;
          const { rows: unitRows } = await client.query(
            `insert into item_units (item_id, code) values ($1,$2) returning id, code, printed, sold`,
            [newItem.id, code]
          );
          units.push(unitRows[0]);
        }

        allocatedNow += allocatedWorkmanship * quantity;
        createdItems.push({
          id: newItem.id,
          ref: newItem.ref,
          lotId: lot.id,
          categoryId: row.categoryId,
          karat: newItem.karat,
          weight: Number(newItem.weight),
          stonesWeight: Number(newItem.stones_weight) || 0,
          costPerGram: newItem.cost_per_gram != null ? Number(newItem.cost_per_gram) : null,
          workmanship: Number(newItem.workmanship) || 0,
          lotWorkmanshipShare: Number(newItem.lot_workmanship_share) || 0,
          fromScrap: false,
          dateAdded: newItem.date_added,
          units: units.map((u) => ({ id: u.id, code: u.code, printed: !!u.printed, sold: !!u.sold })),
        });
      }

      if (allocatedNow > 0) {
        await client.query(
          `update lots set workmanship_allocated = workmanship_allocated + $1 where id = $2`,
          [allocatedNow, lot.id]
        );
      }

      return { items: createdItems };
    });

    if (result.error) {
      const status = result.error === "lot_not_found" || result.error === "category_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
