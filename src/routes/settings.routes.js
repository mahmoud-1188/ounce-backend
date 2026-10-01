import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireManager } from "../middleware/auth.js";
import { provisionLocked } from "../domain/branchProvision.js";

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
        "select tax_enabled, tax_rate, card_fees, workday_mode from branch_settings where branch_id = $1",
        [req.auth.branchId]
      );
      const existing = existingRows[0] || { tax_enabled: true, tax_rate: 0.15, card_fees: {}, workday_mode: "required" };

      // ⚠ فرعٌ مُجهَّز ومقفول من الإدارة: الضريبة ويوم العمل لا تُغيَّر من هنا
      const lock = await provisionLocked(client, req.auth.branchId);
      if (lock) {
        const changed =
          (body.taxEnabled != null && !!body.taxEnabled !== !!existing.tax_enabled) ||
          (body.taxRate != null && Math.abs(Number(body.taxRate) - Number(existing.tax_rate)) > 1e-9) ||
          (body.workdayMode != null && body.workdayMode !== (existing.workday_mode || "required"));
        if (changed) return { error: "settings_locked_by_hq", by: lock.by };
      }

      // يوم العمل: 'required' (يُفتح ويُقفل) أو 'off' (الحركات بلا يوم).
      let workdayMode = existing.workday_mode || "required";
      if (body.workdayMode != null) {
        if (!["required", "off"].includes(body.workdayMode)) return { error: "invalid_workday_mode" };
        workdayMode = body.workdayMode;
      }

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
        `insert into branch_settings (branch_id, tax_enabled, tax_rate, card_fees, workday_mode)
         values ($1, $2, $3, $4, $5)
         on conflict (branch_id) do update
           set tax_enabled = excluded.tax_enabled,
               tax_rate = excluded.tax_rate,
               card_fees = excluded.card_fees,
               workday_mode = excluded.workday_mode
         returning tax_enabled, tax_rate, card_fees, workday_mode`,
        [req.auth.branchId, taxEnabled, taxRate, JSON.stringify(cardFees), workdayMode]
      );
      // الزكاة: مفتاح التشغيل وسنة الحساب (migration 065)
      let zakat = null;
      if (body.zakatEnabled != null || body.zakatYear != null) {
        if (body.zakatYear != null && !["gregorian", "hijri"].includes(body.zakatYear)) return { error: "invalid_zakat_year" };
        const { rows: z } = await client.query(
          `update branch_settings set zakat_enabled = coalesce($2, zakat_enabled), zakat_year = coalesce($3, zakat_year)
            where branch_id = $1 returning zakat_enabled, zakat_year`,
          [req.auth.branchId, body.zakatEnabled != null ? !!body.zakatEnabled : null, body.zakatYear ?? null]
        );
        zakat = z[0];
      }
      // حدّ الآجل الافتراضي وأيام التأخّر (migration 069) — صفر = بلا فحص
      let credit = null;
      if (body.creditLimitDefault != null || body.creditOverdueDays != null) {
        const { rows: cr } = await client.query(
          `update branch_settings set credit_limit_default = coalesce($2, credit_limit_default), credit_overdue_days = coalesce($3, credit_overdue_days)
            where branch_id = $1 returning credit_limit_default, credit_overdue_days`,
          [req.auth.branchId,
           body.creditLimitDefault != null ? Math.max(0, Number(body.creditLimitDefault) || 0) : null,
           body.creditOverdueDays != null ? Math.max(0, Math.min(3650, Math.round(Number(body.creditOverdueDays) || 0))) : null]
        );
        credit = cr[0];
      }
      // تفضيلات البيع (migration 069): تُدمج مفتاحًا مفتاحًا — ما لم يُرسل يبقى
      let prefs = null;
      if (body.salePrefs && typeof body.salePrefs === "object") {
        const p = {};
        if (body.salePrefs.postSaleSheet != null) p.postSaleSheet = !!body.salePrefs.postSaleSheet;
        if (body.salePrefs.sellDuringStocktake != null) p.sellDuringStocktake = !!body.salePrefs.sellDuringStocktake;
        if (body.salePrefs.quoteDays != null) p.quoteDays = Math.max(1, Math.min(60, Math.round(Number(body.salePrefs.quoteDays) || 7)));
        const { rows: pr } = await client.query(
          "update branch_settings set sale_prefs = sale_prefs || $2::jsonb where branch_id = $1 returning sale_prefs",
          [req.auth.branchId, JSON.stringify(p)]);
        prefs = pr[0];
      }
      return { settings: { ...rows[0], ...(zakat || {}), ...(credit || {}), ...(prefs || {}) } };
    });

    if (result.error === "invalid_tax_rate" || result.error === "invalid_zakat_year" || result.error === "invalid_workday_mode") {
      return res.status(400).json({ error: result.error });
    }
    if (result.error === "settings_locked_by_hq") {
      return res.status(409).json(result);
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
