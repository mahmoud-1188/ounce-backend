import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireManager } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

/**
 * الأصول الثابتة والإهلاك — migration 015.
 *
 * الجداول (asset_classes/fixed_assets/depreciation_schedule) موجودة في
 * schema.sql منذ البداية ومصروفة بالكامل في seed.sql (posting_rules.
 * depreciation/asset_purchase/asset_disposal، asset_classes الست، ونفس
 * حسابات الأصول 1410-1490 في core/chart.js عندنا) — لكن بلا endpoint
 * واحد يلمسها، تمامًا كحال RFID قبل migration 014. هذا الملف يفعّلها.
 *
 * ⚠ الحارس requireManager لا نظام موافقات: approval_rules المزروع
 * (asset_purchase/asset_disposal بـthreshold=0, approver_role=manager)
 * غير مُفعَّل في أي مكان بالباك إند فعليًا (لا جدول approvals حقيقي، ولا
 * أي route آخر يقرأ approval_rules) — لو بُني نظام موافقات عام لاحقًا،
 * هذا الملف يحتاج تحويلًا لاستخدامه بدل requireManager المباشر. حاليًا
 * الأقرب عمليًا لمعنى "manager يوافق دومًا" هو تقييد الإجراء بمن هو
 * manager أصلًا — بلا خطوة "طلب ثم موافقة" منفصلة لا تُبنى هنا لأول مرة.
 *
 * ⚠ حساب الحساب الفعلي (1410 أثاث، 1440 أجهزة، ...) يُقرأ من
 * asset_classes.account_code لكل عملية — لا من posting_rules.
 * asset_purchase/asset_disposal المزروع (ذاك مُثبَّت على 1410 كقيمة
 * افتراضية عامة فقط، حرفيًا كيف تتعامل كل route أخرى في هذا الباك إند مع
 * posting_rules: قراءةً توثيقية للتحقق من التطابق لا استدعاءً برمجيًا —
 * getPostingRule في domain/postingRules.js موجود لكن غير مُستخدَم في أي
 * route حاليًا، فعدم استخدامه هنا يطابق النمط القائم لا يخالفه).
 */
router.use("/fixed-assets", authenticate, requirePage("fixedAssets"));
router.use("/asset-classes", authenticate, requirePage("fixedAssets"));

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

// حسابات النقد حسب مصدر التمويل — مطابقة تمامًا لـCASH_ACCOUNTS في
// purchases.routes.js/expenses.routes.js (نفس الأربعة، هنا فقط اثنان
// يُستخدَمان: الخزنة نقدي/شبكة — لا صندوق يومي ولا آجل لشراء/بيع أصل
// ثابت، تمامًا كما في AssetForm/DisposeForm المرجعيين اللذين يعرضان
// safe_cash/safe_network فقط بالإضافة لـdeferred عند الشراء وحده).
const CASH_ACCOUNTS = {
  safe_cash: { pool: "safe", method: "cash", account: "1110" },
  safe_network: { pool: "safe", method: "network", account: "1120" },
};

router.get("/asset-classes", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select id, label, account_code, years, salvage_pct from asset_classes order by id`
      );
      return { assetClasses: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/fixed-assets", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: assets } = await client.query(
        `select a.*, c.label as class_label, c.account_code as class_account,
                c.years as class_years, c.salvage_pct as class_salvage_pct
           from fixed_assets a join asset_classes c on c.id = a.class_id
          where a.branch_id = $1
          order by a.disposed_at is not null, a.purchased_at desc`,
        [req.auth.branchId]
      );
      const { rows: schedule } = await client.query(
        `select d.* from depreciation_schedule d
           join fixed_assets a on a.id = d.asset_id
          where a.branch_id = $1
          order by d.period`,
        [req.auth.branchId]
      );
      return { assets, depreciations: schedule };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/fixed-assets", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const classId = body.classId;
  const name = (body.name || "").trim();
  const cost = roundMoney(body.cost);
  const purchasedAt = body.purchasedAt || body.inServiceDate;
  const fundingSource = body.fundingSource;
  // ⚠ null صريح يعني "اتّبع الفئة" — 0 قيمة صالحة فعلًا لخردة/سنوات
  // مُعطاة عمدًا فلا يجوز أن يسقطها `|| null` سهوًا (0 سنة غير منطقي
  // فعليًا فسيُرفض لاحقًا، لكن salvagePct=0 شائع جدًا — أجهزة/سيارات).
  const years = body.years === "" || body.years == null ? null : Number(body.years);
  const salvagePct = body.salvagePct === "" || body.salvagePct == null ? null : Number(body.salvagePct);
  const method = body.method === "declining" ? "declining" : "straight";

  if (!name) return res.status(400).json({ error: "name_required" });
  if (!(cost > 0)) return res.status(400).json({ error: "invalid_cost" });
  if (!purchasedAt) return res.status(400).json({ error: "purchased_at_required" });
  if (years != null && !(years > 0)) return res.status(400).json({ error: "invalid_years" });
  if (salvagePct != null && !(salvagePct >= 0 && salvagePct < 100)) {
    return res.status(400).json({ error: "invalid_salvage_pct" });
  }
  const isDeferred = fundingSource === "deferred";
  if (!isDeferred && !CASH_ACCOUNTS[fundingSource]) {
    return res.status(400).json({ error: "invalid_funding_source" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: clsRows } = await client.query(
        `select id, account_code from asset_classes where id = $1`,
        [classId]
      );
      const cls = clsRows[0];
      if (!cls) return { error: "invalid_class" };

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from fixed_assets where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `AST-${String(refRows[0].n).padStart(5, "0")}`;

      const { rows: assetRows } = await client.query(
        `insert into fixed_assets
           (branch_id, ref, class_id, name, cost, purchased_at, years, salvage_pct, method, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning *`,
        [req.auth.branchId, ref, classId, name, cost, purchasedAt, years, salvagePct, method, req.auth.userId]
      );
      const asset = assetRows[0];

      const businessDayId = await openDay(client, req.auth.branchId);
      let journalEntryId = null;

      if (isDeferred) {
        // ⚠ آجل: التزام على 2130 (نفس حساب التزامات مكاتب التسكير في
        // المرجع — لا حساب "دائنو أصول ثابتة" مخصَّص في chart.js، و2130
        // "مكاتب تسكير — التزام" هو الأقرب دلاليًا لالتزام مقابل أصل غير
        // ذهبي حتى يُسدَّد لاحقًا، أفضل من إقحامه في 2110/2120 الذهبيين
        // تمامًا بلا معنى لأصل ثابت نقدي).
        journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "asset_purchase",
          refTable: "fixed_assets",
          refId: asset.id,
          description: `شراء أصل ثابت — ${name} (${ref})`,
          createdBy: req.auth.userId,
          lines: [
            { account: cls.account_code, side: "debit", amount: cost },
            { account: "2130", side: "credit", amount: cost },
          ],
        });
      } else {
        const { pool, method: payMethod, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,'out',$5,'fixed_asset_purchase',$6,$7,$8,$9)`,
          [req.auth.branchId, businessDayId, pool, payMethod, cost, "fixed_assets", asset.id, `شراء أصل ثابت — ${name} (${ref})`, req.auth.userId]
        );
        journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "asset_purchase",
          refTable: "fixed_assets",
          refId: asset.id,
          description: `شراء أصل ثابت — ${name} (${ref})`,
          createdBy: req.auth.userId,
          lines: [
            { account: cls.account_code, side: "debit", amount: cost },
            { account: cashAccount, side: "credit", amount: cost },
          ],
        });
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'fixed_assets',$3,$4)`,
        [req.auth.branchId, req.auth.userId, asset.id, JSON.stringify({ ref, name, cost, classId, fundingSource })]
      );

      return { asset, journalEntryId };
    });

    if (result.error === "invalid_class") return res.status(400).json({ error: "invalid_class" });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * تشغيل إهلاك شهر — مطابق منطقيًا لـbuildDepreciationJournal المرجعي
 * (سطرًا بسطر تقريبًا) لكن بقراءة/كتابة فعلية على القاعدة بدل حساب محلي
 * بحت: لكل أصل غير مستبعَد وغير مُهلَك بالكامل وقد بدأ التشغيل فعلًا
 * وقتها ولم يُهلَك لنفس الشهر من قبل — يُحسَب القسط (مقصوصًا عند حافة
 * الخردة تمامًا)، ثم قيد واحد مُجمَّع (6800 مدين/1490 دائن) لكل الأصول
 * معًا، وسطر depreciation_schedule منفصل لكل أصل يشير لنفس القيد.
 */
router.post("/fixed-assets/depreciation/run", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const period = body.period; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(period || "")) return res.status(400).json({ error: "invalid_period" });
  const periodDate = `${period}-01`;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: assets } = await client.query(
        `select a.*, c.years as class_years, c.salvage_pct as class_salvage_pct
           from fixed_assets a join asset_classes c on c.id = a.class_id
          where a.branch_id = $1 and a.disposed_at is null
          order by a.purchased_at`,
        [req.auth.branchId]
      );
      const { rows: existing } = await client.query(
        `select d.asset_id, d.period from depreciation_schedule d
           join fixed_assets a on a.id = d.asset_id
          where a.branch_id = $1`,
        [req.auth.branchId]
      );
      const alreadyRunIds = new Set(
        existing.filter((d) => d.period.toISOString().slice(0, 7) === period).map((d) => d.asset_id)
      );

      const details = [];
      for (const a of assets) {
        if (alreadyRunIds.has(a.id)) continue;
        if (String(a.purchased_at).slice(0, 7) > period) continue;

        const years = Number(a.years ?? a.class_years) || 1;
        const salvagePct = Number(a.salvage_pct ?? a.class_salvage_pct) || 0;
        const cost = Number(a.cost);
        const salvage = (cost * salvagePct) / 100;
        const monthsTotal = Math.max(1, years * 12);
        // القيمة الدفترية الحالية = التكلفة ناقص كل ما أُهلك فعليًا حتى
        // الآن — نجلبها بمبلغ حقيقي لا بعدّ الأشهر فقط، فتخطي شهر (أصل
        // أُضيف متأخرًا) لا يكسر الحساب.
        const { rows: sumRows } = await client.query(
          `select coalesce(sum(amount), 0)::numeric as accum from depreciation_schedule where asset_id = $1`,
          [a.id]
        );
        const accumSoFar = Number(sumRows[0].accum);
        const bookValue = cost - accumSoFar;
        if (bookValue <= salvage + 1) continue; // مُهلَك بالكامل عمليًا

        let amount;
        if (a.method === "declining") {
          const rate = 2 / monthsTotal;
          amount = Math.min(roundMoney(bookValue * rate), roundMoney(bookValue - salvage));
        } else {
          amount = roundMoney((cost - salvage) / monthsTotal);
        }
        const room = roundMoney(bookValue - salvage);
        if (amount > room) amount = room;
        if (!(amount > 0)) continue;

        details.push({ assetId: a.id, ref: a.ref, name: a.name, amount });
      }

      if (details.length === 0) return { entry: null, details: [], total: 0 };

      const total = details.reduce((sum, d) => sum + d.amount, 0);
      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId: null,
        opType: "depreciation",
        refTable: "fixed_assets",
        refId: null,
        description: `إهلاك شهر ${period}`,
        createdBy: req.auth.userId,
        lines: [
          { account: "6800", side: "debit", amount: total },
          { account: "1490", side: "credit", amount: total },
        ],
      });

      for (const d of details) {
        await client.query(
          `insert into depreciation_schedule (asset_id, period, amount, posted, journal_entry_id)
           values ($1,$2,$3,true,$4)`,
          [d.assetId, periodDate, d.amount, journalEntryId]
        );
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'depreciation_schedule',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ period, total, count: details.length, journalEntryId })]
      );

      return { entry: { id: journalEntryId }, details, total };
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * استبعاد أصل (بيع أو إتلاف) — مطابق لـDisposeForm المرجعي: الربح/
 * الخسارة = المتحصّل − القيمة الدفترية وقت الاستبعاد. قيد الاستبعاد:
 *   مدين  1490 (مجمّع إهلاك هذا الأصل)     بما أُهلك فعليًا
 *   مدين  حساب النقد (لو بيع)              بالمتحصّل
 *   مدين  6810 (خسارة استبعاد)             لو النتيجة سالبة
 *   دائن  حساب فئة الأصل                   بالتكلفة الكاملة
 *   دائن  4210 (ربح رأسمالي محقق)            لو النتيجة موجبة — يطابق
 *                                             سلوك buildDisposalJournal.js
 *                                             الفرونت إندي الفعلي
 */
router.post("/fixed-assets/:id/dispose", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const reason = body.reason === "scrap" ? "scrap" : "sale";
  const proceeds = reason === "sale" ? roundMoney(body.proceeds) : 0;
  const fundingSource = body.fundingSource;
  if (reason === "sale" && proceeds > 0 && !CASH_ACCOUNTS[fundingSource]) {
    return res.status(400).json({ error: "invalid_funding_source" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: assetRows } = await client.query(
        `select a.*, c.account_code as class_account, c.years as class_years,
                c.salvage_pct as class_salvage_pct
           from fixed_assets a join asset_classes c on c.id = a.class_id
          where a.id = $1 and a.branch_id = $2
          for update of a`,
        [req.params.id, req.auth.branchId]
      );
      const asset = assetRows[0];
      if (!asset) return { error: "not_found" };
      if (asset.disposed_at) return { error: "already_disposed" };

      const { rows: sumRows } = await client.query(
        `select coalesce(sum(amount), 0)::numeric as accum from depreciation_schedule where asset_id = $1`,
        [asset.id]
      );
      const accumulated = Number(sumRows[0].accum);
      const cost = Number(asset.cost);
      const bookValue = roundMoney(cost - accumulated);
      const gain = roundMoney(proceeds - bookValue);

      const businessDayId = await openDay(client, req.auth.branchId);

      const lines = [];
      if (accumulated > 0) lines.push({ account: "1490", side: "debit", amount: roundMoney(accumulated) });
      if (proceeds > 0) {
        const { pool, method, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,'in',$5,'fixed_asset_disposal',$6,$7,$8,$9)`,
          [req.auth.branchId, businessDayId, pool, method, proceeds, "fixed_assets", asset.id, `استبعاد أصل — ${asset.name} (${asset.ref})`, req.auth.userId]
        );
        lines.push({ account: cashAccount, side: "debit", amount: proceeds });
      }
      if (gain < 0) lines.push({ account: "6810", side: "debit", amount: roundMoney(-gain) });
      lines.push({ account: asset.class_account, side: "credit", amount: cost });
      // ⚠ 4210 لا 4390: المرجع نفسه (buildDisposalJournal.js دورّ فرونت
      // إندنا القائم) يستخدم 4210 ("ربح رأسمالي محقق من السعر") لربح
      // استبعاد الأصل رغم أن 4220/4210 مُسمّيان أصلًا لربح/خسارة السعر —
      // نطابق سلوكه الفعلي حرفيًا لا تسمية الحساب النظرية، فبقاء الفرونت
      // والباك على نفس الحساب أهم من دقّة تسمية لم يلتزم بها المرجع نفسه.
      if (gain > 0) lines.push({ account: "4210", side: "credit", amount: gain });

      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: "asset_disposal",
        refTable: "fixed_assets",
        refId: asset.id,
        description: `استبعاد أصل — ${asset.name} (${asset.ref})`,
        createdBy: req.auth.userId,
        lines,
      });

      const { rows: updated } = await client.query(
        `update fixed_assets
            set disposed_at = now(), disposal_reason = $1, disposal_proceeds = $2,
                disposal_gain = $3, disposal_funding_source = $4, disposed_by = $5
          where id = $6
          returning *`,
        [reason, proceeds, gain, proceeds > 0 ? fundingSource : null, req.auth.userId, asset.id]
      );

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'fixed_assets',$3,$4)`,
        [req.auth.branchId, req.auth.userId, asset.id, JSON.stringify({ action: "dispose", reason, proceeds, gain })]
      );

      return { asset: updated[0], journalEntryId, gain };
    });

    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    if (result.error === "already_disposed") return res.status(409).json({ error: "already_disposed" });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
