import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireManager } from "../middleware/auth.js";

const router = Router();

/**
 * تعديل الضريبة/رسوم الشبكة وقفل الجرد كلاهما كان مفروضًا فعليًا من
 * السيرفر (sales.routes.js/scrap.routes.js يقرآن branch_settings و
 * stocktake_locks على كل عملية بيع/كسر) لكن الواجهة كانت تُغيّرهما محليًا
 * فقط — أي تغيير من الشاشة لم يكن يصل للسيرفر إطلاقًا. هذا الملف يسدّ
 * الفجوة بإضافة مسارَي الكتابة.
 *
 * صلاحيتان مختلفتان قصدًا لا واحدة موحّدة لكل الملف:
 *  - /settings/branch (ضريبة/رسوم): صفحة "settings" + مدير فقط — بنفس
 *    صلاحية "مدير فقط" المستخدمة أصلًا لعمليات الخزنة الحساسة المشابهة
 *    (راجع safe.routes.js `/safe/audit`).
 *  - /settings/stocktake-lock: صفحة "stocktake" بلا قيد الدور — يطابق
 *    الواجهة تمامًا (`StocktakeSubPage`'s `onToggleLock` بلا أي شرط
 *    `role === "manager"`)، فالمساعد (assistant) الذي يملك صفحة الجرد
 *    يقدر يقفل/يفتح الجرد تمامًا كما في المرجع.
 */
router.use("/settings", authenticate);

const CARD_NETWORKS = ["mada", "visa", "mastercard", "amex"];

router.patch("/settings/branch", requirePage("settings"), requireManager, async (req, res, next) => {
  const body = req.body || {};
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: existingRows } = await client.query(
        "select tax_enabled, tax_rate, card_fees from branch_settings where branch_id = $1",
        [req.auth.branchId]
      );
      const existing = existingRows[0] || { tax_enabled: true, tax_rate: 0.15, card_fees: {} };

      const taxEnabled = body.taxEnabled != null ? !!body.taxEnabled : existing.tax_enabled;

      let taxRate = existing.tax_rate;
      if (body.taxRate != null) {
        const n = Number(body.taxRate);
        if (!(n >= 0) || n > 1) return { error: "invalid_tax_rate" };
        taxRate = n;
      }

      let cardFees = existing.card_fees || {};
      if (body.cardFees && typeof body.cardFees === "object") {
        cardFees = { ...cardFees };
        for (const [network, fee] of Object.entries(body.cardFees)) {
          if (!CARD_NETWORKS.includes(network)) continue;
          const n = Number(fee);
          if (!(n >= 0)) return { error: "invalid_card_fee", network };
          cardFees[network] = n;
        }
      }

      const { rows } = await client.query(
        `insert into branch_settings (branch_id, tax_enabled, tax_rate, card_fees)
         values ($1, $2, $3, $4)
         on conflict (branch_id) do update
           set tax_enabled = excluded.tax_enabled,
               tax_rate = excluded.tax_rate,
               card_fees = excluded.card_fees
         returning tax_enabled, tax_rate, card_fees`,
        [req.auth.branchId, taxEnabled, taxRate, JSON.stringify(cardFees)]
      );
      return { settings: rows[0] };
    });

    if (result.error === "invalid_tax_rate") {
      return res.status(400).json({ error: "invalid_tax_rate" });
    }
    if (result.error === "invalid_card_fee") {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/settings/stocktake-lock", requirePage("stocktake"), async (req, res, next) => {
  const body = req.body || {};
  const locked = !!body.locked;
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `insert into stocktake_locks (branch_id, locked, locked_by, locked_at)
         values ($1, $2, $3, $4)
         on conflict (branch_id) do update
           set locked = excluded.locked,
               locked_by = excluded.locked_by,
               locked_at = excluded.locked_at
         returning locked, locked_by, locked_at`,
        [req.auth.branchId, locked, locked ? req.auth.userId : null, locked ? new Date() : null]
      );
      return { stocktakeLock: rows[0] };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
