import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";

const router = Router();

/**
 * ربط/فكّ بطاقة RFID (EPC) بوحدة صنف — item_units.epc (migration 014).
 *
 * لا صفحة واحدة تملك هذا: المرجع يفتح BindEpcSheet من ثلاث شاشات مختلفة
 * (التكويد عند الإدخال، الجرد حين تظهر بطاقة غير معروفة أثناء المسح،
 * والمبيعات/الاسترجاع لنفس السبب) — فالحارس هنا requireAnyPage لا
 * requirePage لصفحة واحدة. القراءة الفعلية للبطاقة (البلوتوث/HID) تجري
 * بالكامل في المتصفح؛ هذا الـendpoint فقط يكتب الربط في قاعدة البيانات
 * كي يظهر لكل مستخدم بعد أي تحديث/دخول جديد، لا في متصفح من ربطها فقط.
 */
router.use("/rfid", authenticate);

router.post(
  "/rfid/bind",
  requireAnyPage("addGoods", "stocktake", "sales", "salesReturn", "inventory", "itemEdit"),
  async (req, res, next) => {
    const body = req.body || {};
    const unitId = body.unitId;
    const epc = typeof body.epc === "string" ? body.epc.trim().toUpperCase() : "";
    if (!unitId) return res.status(400).json({ error: "unit_id_required" });
    if (!epc) return res.status(400).json({ error: "epc_required" });
    // ⚠ طول EPC الفعلي متغيّر بحسب البطاقة (96/128 بت شائعة) — نتحقق من
    // شكل عام (سداسي عشري) لا من طول ثابت، كي لا نرفض بطاقة صالحة أطول
    // أو أقصر مما توقعناه.
    if (!/^[0-9A-F]{4,64}$/.test(epc)) return res.status(400).json({ error: "invalid_epc_format" });

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: unitRows } = await client.query(
          `select u.id, u.code, u.epc, i.branch_id
             from item_units u join items i on i.id = u.item_id
            where u.id = $1
            for update of u`,
          [unitId]
        );
        const unit = unitRows[0];
        if (!unit || unit.branch_id !== req.auth.branchId) return { error: "unit_not_found" };

        const { rows: dupRows } = await client.query(
          `select u.id, u.code, i.branch_id
             from item_units u join items i on i.id = u.item_id
            where u.epc = $1`,
          [epc]
        );
        const dup = dupRows[0];
        if (dup && dup.id !== unit.id) {
          // ⚠ نفس البطاقة قد تكون مربوطة بوحدة أخرى في نفس الفرع (خطأ
          // سابق) أو في فرع مختلف تمامًا — الرسالة توضّح فقط أنها
          // مستخدمة، لا تُسرّب رقم/بيانات الفرع الآخر إن اختلف.
          return { error: "epc_already_bound", sameBranch: dup.branch_id === req.auth.branchId, code: dup.branch_id === req.auth.branchId ? dup.code : null };
        }

        const { rows } = await client.query(
          `update item_units set epc = $1, epc_bound_at = now(), epc_bound_by = $2
            where id = $3
            returning id, code, epc, epc_bound_at`,
          [epc, req.auth.userId, unitId]
        );

        await client.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
           values ($1,'update',$2,'item_units',$3,$4)`,
          [req.auth.branchId, req.auth.userId, unitId, JSON.stringify({ action: "rfid_bind", code: unit.code, epc, previousEpc: unit.epc || null })]
        );

        return { unit: rows[0] };
      });

      if (result.error === "unit_not_found") return res.status(404).json(result);
      if (result.error === "epc_already_bound") return res.status(409).json(result);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  "/rfid/unbind",
  requireAnyPage("addGoods", "stocktake", "sales", "salesReturn", "inventory", "itemEdit"),
  async (req, res, next) => {
    const body = req.body || {};
    const unitId = body.unitId;
    if (!unitId) return res.status(400).json({ error: "unit_id_required" });
    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: unitRows } = await client.query(
          `select u.id, u.code, u.epc, i.branch_id
             from item_units u join items i on i.id = u.item_id
            where u.id = $1`,
          [unitId]
        );
        const unit = unitRows[0];
        if (!unit || unit.branch_id !== req.auth.branchId) return { error: "unit_not_found" };

        const { rows } = await client.query(
          `update item_units set epc = null, epc_bound_at = null, epc_bound_by = null
            where id = $1
            returning id, code`,
          [unitId]
        );

        await client.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
           values ($1,'update',$2,'item_units',$3,$4)`,
          [req.auth.branchId, req.auth.userId, unitId, JSON.stringify({ action: "rfid_unbind", code: unit.code, previousEpc: unit.epc || null })]
        );

        return { unit: rows[0] };
      });
      if (result.error === "unit_not_found") return res.status(404).json(result);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
