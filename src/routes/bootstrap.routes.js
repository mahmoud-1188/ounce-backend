import { Router } from "express";
import { withBranch, withBranchParallel } from "../db.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

router.use("/bootstrap", authenticate);

/**
 * GET /api/bootstrap — كل بيانات الفرع دفعة واحدة بعد تسجيل الدخول.
 *
 * ⚠ قرار معماري صريح (بطلب المستخدم، لضمان عدم وجود أي "لود" أثناء
 * التنقل بين شاشات الفرونت إند): الفرونت إند القديم كان يحمّل كل شيء من
 * localStorage دفعة واحدة عبر loadAllStores() ثم يتنقّل بين الشاشات محليًا
 * بالكامل من نفس الحالة. هذا الـendpoint يقوم بنفس الدور تمامًا لكن
 * المصدر Postgres بدل localStorage — يُستدعى مرة واحدة عند الدخول، والفرونت
 * إند يخزّن النتيجة في React state، والتنقل بين الشاشات بعدها محلي 100%
 * (بلا أي طلب شبكة إضافي). أي عملية (بيع/شراء/كسر/إلخ) تذهب لاحقًا لـ
 * endpoint الكتابة الخاص بها، وتُحدَّث نفس الحالة المحلية بنمط optimistic
 * (تحديث الشاشة فورًا، والطلب يمشي في الخلفية) — تمامًا كآلية persist()
 * الأصلية في المرجع.
 *
 * ⚠ نطاق متعمَّد: يغطي فقط الجداول التي بُنيت لها فعليًا endpoints كتابة
 * حقيقية حتى الآن (المبيعات، الشراء، الكسر، الخزنة/الإخراج، الأصناف،
 * المستخدمون، والآن الأصول الثابتة/الإهلاك — migration 015). جداول أخرى
 * موجودة في الـschema (رواتب، ميزانيات، GOSI...) غير موصولة بأي منطق
 * باك إند بعد — ستُضاف لهذا الـendpoint حين تُبنى فعليًا، لا نظريًا.
 *
 * ⚠ حساسية البيانات: قائمة المستخدمين هنا مُصغَّرة (بلا pin_hash وبلا
 * salary) خلافًا لـGET /api/users الكاملة (المحمية بصلاحية "access" فقط)
 * — لأن bootstrap يُحمَّل لكل مستخدم مسجَّل دخول بصرف النظر عن دوره، وراتب
 * الموظفين ليس بيانًا يجب أن يراه كل مستخدم. لنفس السبب، بيانات الرواتب/
 * HR كاملةً (migration 016 — payroll.routes.js) غير مُضمَّنة هنا إطلاقًا:
 * تُجلَب فقط عند فتح شاشة الرواتب فعليًا (GET /api/hr/staff،
 * /api/payroll/runs، ...) المحمية بصلاحية "payroll" لا كل مستخدم.
 *
 * ⚠ أداء — إصلاح حقيقي (2026-09): كانت كل الاستعلامات أدناه (26 استعلامًا)
 * تُنفَّذ بالتتابع (await واحدًا تلو الآخر) على نفس عميل pg الواحد، لأن
 * عميلًا واحدًا لا يقبل تشغيل استعلامات متزامنة، وكانت جميعها ملفوفة داخل
 * withBranch() (معاملة واحدة على اتصال واحد). هذا كان يجعل bootstrap يأخذ
 * 5-6 ثوانٍ فعليًا (26 رحلة ذهاب-وإياب متتالية لقاعدة البيانات، لا استعلامًا
 * واحدًا بطيئًا) رغم أن كل استعلام على حدة سريع وبسيط.
 *
 * الحل: withBranchParallel() تُشغّل كل استعلام SELECT في معاملته الخاصة
 * القصيرة على اتصاله الخاص من الـpool (10 اتصالات افتراضيًا)، وكلها معًا
 * عبر Promise.all — فيصبح الزمن الكلي محكومًا بأبطأ استعلام واحد تقريبًا
 * لا بمجموع الكل. هذا آمن هنا تحديدًا لأن كل الاستعلامات أدناه قراءة فقط
 * (SELECT) ولا تعتمد على نتيجة بعضها البعض — لا حاجة فعلية لمعاملة واحدة
 * تجمعها كلها (على عكس مسارات الكتابة الأخرى التي تبقى على withBranch
 * العادي عمدًا).
 */
router.get("/bootstrap", async (req, res, next) => {
  try {
    const branchId = req.auth.branchId;

    const [
      branch,
      businessDay,
      stocktakeLock,
      dailyCustody,
      branchSettings,
      categories,
      items,
      itemUnits,
      customers,
      suppliers,
      sales,
      saleLines,
      lots,
      scrapItems,
      scrapRequests,
      cashTx,
      safeGoldTx,
      safeAudits,
      goldIssues,
      taskirOffices,
      taskirEntries,
      taskirOfficeTx,
      users,
      expenses,
      expenseNames,
      reservations,
      repairs,
      returns,
      receipts,
      assetClasses,
      fixedAssets,
      depreciationSchedule,
      journalEntriesRaw,
      journalLinesRaw,
      goldLedgerRaw,
    ] = await withBranchParallel(branchId, [
      // ⚠ توسيع حقيقي: كان يُحمَّل عمود مُصغَّر لآخر يوم فقط، لكن WorkDayPage
      // في المرجع تعرض أيضًا سجل "الأيام السابقة" (ref، فتح/إقفال، مبيعات،
      // ربح، مصاريف) من businessDays نفسها — لا مصدر آخر له. نحمّل آخر 90
      // يومًا (سنة عمل تقريبًا) بكل أعمدة اللقطة، لا عمودًا مُصغَّرًا للأحدث فقط.
      // is_hq مُضاف هنا (migration 017): بيانات فرع عادية لا حساسية فيها
      // (خلاف الرواتب) — الواجهة تحتاجها لتقرّر إظهار تبويب "تقرير
      // الفروع" من عدمه بلا استدعاء إضافي عند كل تحميل.
      (client) => client.query(`select id, ref, name, is_hq from branches where id = $1`, [branchId]),
      (client) =>
        client.query(
          `select * from business_days
             where branch_id = $1 order by opened_at desc limit 90`,
          [branchId]
        ),
      // ⚠ إصلاح حقيقي: العمود الصحيح locked_by لا started_by (لم يُتحقق
      // من الـschema فعليًا قبل أول تشغيل — درس متكرر في هذا المشروع).
      (client) =>
        client.query(`select locked, locked_by, locked_at from stocktake_locks where branch_id = $1`, [branchId]),
      // ⚠ آخر 60 سجل عهدة صندوق يومي — تكفي لعرض الحالي + تاريخ قريب في
      // WorkDayPage بلا حمل bootstrap بسجل طويل لا يُعرض عمليًا.
      (client) =>
        client.query(`select * from daily_custody where branch_id = $1 order by opened_at desc limit 60`, [branchId]),
      (client) =>
        client.query(`select tax_enabled, tax_rate, card_fees, workday_mode from branch_settings where branch_id = $1`, [branchId]),
      // فئات مشتركة بين الفروع (branch_id يمكن أن يكون null) + فئات هذا الفرع تحديدًا.
      // ⚠ order by sort_order صريح الآن (migration 029) — بلا هذا كان
      // ترتيب categories يعود عشوائيًّا فعليًّا (لا ضمان ترتيب من
      // PostgreSQL بلا order by)، فتتبدّل مواضع التصنيفات بين كل تحميل.
      (client) => client.query(`select * from categories where branch_id = $1 or branch_id is null order by sort_order, name`, [branchId]),
      (client) => client.query(`select * from items where branch_id = $1 order by date_added desc`, [branchId]),
      (client) =>
        client.query(
          `select u.* from item_units u join items i on i.id = u.item_id
             where i.branch_id = $1`,
          [branchId]
        ),
      (client) => client.query(`select * from customers where branch_id = $1 order by name`, [branchId]),
      (client) => client.query(`select * from suppliers where branch_id = $1 order by name`, [branchId]),
      (client) => client.query(`select * from sales where branch_id = $1 order by date desc limit 500`, [branchId]),
      // ⚠ ORDER BY line_no إلزامي (migration 013): بلا ترتيب حتمي، فهرس
      // السطر الذي يراه المستخدم في الشاشة (ويُرسَل لاحقًا عند الإرجاع)
      // قد لا يطابق أي سطر فعليًا على الخادم.
      (client) =>
        client.query(
          `select sl.* from sale_lines sl join sales s on s.id = sl.sale_id
             where s.branch_id = $1
            order by sl.sale_id, sl.line_no`,
          [branchId]
        ),
      // ⚠ إصلاح حقيقي: كانت `select * from lots` تُرجِع صفّ الدفعة وحده،
      // بلا payment_method/office_id/invoice_pending — هذه الأعمدة تعيش
      // فعليًا على purchases (رأس الشراء)، لا على كل سطر lot بداخله.
      // normalizeLots في الفرونت إند (core/normalize.js) تحتاجها لعرض
      // طريقة السداد وحالة الفاتورة بنفس شكل المرجع القديم — LEFT JOIN
      // (لا JOIN عادي) لأن lots القديمة (قبل migration 004) قد تحمل
      // purchase_id = null.
      (client) =>
        client.query(
          `select l.*, p.payment_method, p.office_id, p.invoice_pending, p.pay_fees_now, p.notes as purchase_notes
             from lots l
             left join purchases p on p.id = l.purchase_id
            where l.branch_id = $1
            order by l.date desc`,
          [branchId]
        ),
      (client) =>
        client.query(`select * from scrap_items where branch_id = $1 order by created_at desc limit 500`, [branchId]),
      (client) =>
        client.query(`select * from scrap_requests where branch_id = $1 order by created_at desc limit 200`, [branchId]),
      (client) => client.query(`select * from cash_tx where branch_id = $1 order by created_at desc limit 500`, [branchId]),
      (client) =>
        client.query(`select * from safe_gold_tx where branch_id = $1 order by created_at desc limit 500`, [branchId]),
      (client) =>
        client.query(`select * from safe_audits where branch_id = $1 order by created_at desc limit 100`, [branchId]),
      (client) =>
        client.query(`select * from gold_issues where branch_id = $1 order by created_at desc limit 200`, [branchId]),
      (client) => client.query(`select * from taskir_offices where branch_id = $1 order by name`, [branchId]),
      (client) =>
        client.query(`select * from taskir_entries where branch_id = $1 order by created_at desc limit 200`, [branchId]),
      (client) =>
        client.query(`select * from taskir_office_tx where branch_id = $1 order by created_at desc limit 200`, [branchId]),
      (client) =>
        client.query(
          `select u.id, u.name, u.ref, u.role, u.can_use_ai, u.allowed_pages, u.active, u.created_at,
                  r.allowed_tabs, r.allowed_more
             from users u join roles r on r.id = u.role
            where u.branch_id = $1 and u.active = true
            order by u.name`,
          [branchId]
        ),
      (client) =>
        client.query(`select * from expenses where branch_id = $1 order by created_at desc limit 500`, [branchId]),
      (client) =>
        client.query(`select * from expense_names where branch_id = $1 or branch_id is null order by name`, [branchId]),
      // ⚠ الحجوزات/الإصلاحات/المرتجعات — migration 013 (كانت محلية بالكامل
      // بلا أي عمود لها هنا قبل ذلك، فتختفي عند إعادة التحميل).
      (client) =>
        client.query(
          `select r.*, c.name as customer_name from reservations r
             left join customers c on c.id = r.customer_id
            where r.branch_id = $1 order by r.created_at desc limit 300`,
          [branchId]
        ),
      (client) =>
        client.query(`select * from repairs where branch_id = $1 order by created_at desc limit 300`, [branchId]),
      (client) =>
        client.query(`select * from returns where branch_id = $1 order by created_at desc limit 300`, [branchId]),
      (client) =>
        client.query(`select * from receipts where branch_id = $1 order by created_at desc limit 300`, [branchId]),
      (client) => client.query(`select * from asset_classes order by id`),
      (client) =>
        client.query(`select * from fixed_assets where branch_id = $1 order by purchased_at desc`, [branchId]),
      (client) =>
        client.query(
          `select d.* from depreciation_schedule d
             join fixed_assets a on a.id = d.asset_id
            where a.branch_id = $1
            order by d.period`,
          [branchId]
        ),
      // ⚠ إصلاح فجوة حقيقية (2026-09): كل عملية (بيع/شراء/مصروف/كسر...)
      // تكتب فعليًا قيدًا متوازيًا في journal_entries/journal_lines عبر
      // postJournalEntry (domain/journal.js)، ومشغّل check_journal_balance
      // في schema.sql يمنع أي قيد غير متوازن على مستوى القاعدة نفسها — لا
      // افتراض. لكن هذا الجدول لم يكن يُحمّل هنا إطلاقًا، فشاشات الأستاذ
      // العام/اليومية/ميزان المراجعة/القوائم المالية المنقولة من مرجع
      // العميل كانت تعمل على مصفوفة `journal` محلية بحتة (localStorage عبر
      // window.storage) منفصلة تمامًا عن القيود الحقيقية. آخر 2000 قيد
      // تكفي عمليًا (تفوق ما يعرضه أي تقرير دفعة واحدة) بلا إثقال bootstrap
      // بسجل غير محدود.
      (client) =>
        client.query(
          `select e.id, e.op_type, e.ref_table, e.ref_id, e.description,
                  e.created_by, e.created_at, e.reversed_of,
                  u.name as created_by_name,
                  coalesce(pr.label, e.op_type) as label
             from journal_entries e
             left join users u on u.id = e.created_by
             left join posting_rules pr on pr.op_type = e.op_type
            where e.branch_id = $1
            order by e.created_at desc
            limit 2000`,
          [branchId]
        ),
      (client) =>
        client.query(
          `select l.entry_id, l.account_code, l.side, l.amount
             from journal_lines l
             join journal_entries e on e.id = l.entry_id
            where e.branch_id = $1
            order by l.entry_id`,
          [branchId]
        ),
      (client) =>
        client.query(
          `select g.id, g.op_type, g.karat, g.weight, g.fine_weight,
                  g.from_account, g.to_account, g.ref_table, g.ref_id, g.note,
                  g.created_at, u.name as created_by_name
             from gold_ledger_entries g
             left join users u on u.id = g.created_by
            where g.branch_id = $1
            order by g.created_at desc
            limit 2000`,
          [branchId]
        ),
    ]);

    const linesByEntry = new Map();
    for (const l of journalLinesRaw.rows) {
      if (!linesByEntry.has(l.entry_id)) linesByEntry.set(l.entry_id, []);
      linesByEntry.get(l.entry_id).push({
        account: l.account_code,
        debit: l.side === "debit" ? Number(l.amount) : 0,
        credit: l.side === "credit" ? Number(l.amount) : 0,
      });
    }
    const reversedIds = new Set(
      journalEntriesRaw.rows.filter((e) => e.reversed_of).map((e) => e.reversed_of)
    );
    const journal = journalEntriesRaw.rows.map((e) => ({
      id: e.id,
      ref: e.id.slice(0, 8).toUpperCase(),
      date: e.created_at,
      opType: e.op_type,
      label: e.label,
      lines: linesByEntry.get(e.id) || [],
      note: e.description || "",
      createdBy: e.created_by_name || "",
      posted: true,
      isReversal: !!e.reversed_of,
      reversalOf: e.reversed_of || null,
      reversed: reversedIds.has(e.id),
      refTable: e.ref_table || null,
      refId: e.ref_id || null,
    }));

    const goldLedger = [];
    for (const r of goldLedgerRaw.rows) {
      const base = {
        id: r.id,
        at: r.created_at,
        ref: r.id.slice(0, 8).toUpperCase(),
        opType: r.op_type,
        karat: Number(r.karat),
        weight: Number(r.weight),
        note: r.note || "",
        createdBy: r.created_by_name || "",
      };
      if (r.from_account) goldLedger.push({ ...base, accountCode: r.from_account, type: "out" });
      if (r.to_account) goldLedger.push({ ...base, accountCode: r.to_account, type: "in" });
    }

    res.json({
      branch: branch.rows[0] || null,
      // ⚠ businessDay (مفرد) يبقى بشكله الأصلي (أحدث سجل فقط) — لا يُكسَر
      // عقد المستهلك الحالي في bootstrap.routes.js/normalize.js. businessDays
      // (جمع) إضافة جديدة: قائمة كاملة بكل أعمدة اللقطة، لعرض سجل "الأيام
      // السابقة" في WorkDayPage الذي لا مصدر آخر له.
      businessDay: businessDay.rows[0] || null,
      businessDays: businessDay.rows,
      stocktakeLock: stocktakeLock.rows[0] || null,
      dailyCustody: dailyCustody.rows,
      settings: branchSettings.rows[0] || { tax_enabled: true, tax_rate: 0.15, card_fees: {}, workday_mode: "required" },
      categories: categories.rows,
      items: items.rows,
      itemUnits: itemUnits.rows,
      customers: customers.rows,
      suppliers: suppliers.rows,
      sales: sales.rows,
      saleLines: saleLines.rows,
      lots: lots.rows,
      scrapItems: scrapItems.rows,
      scrapRequests: scrapRequests.rows,
      cashTx: cashTx.rows,
      safeGoldTx: safeGoldTx.rows,
      safeAudits: safeAudits.rows,
      goldIssues: goldIssues.rows,
      taskirOffices: taskirOffices.rows,
      taskirEntries: taskirEntries.rows,
      taskirOfficeTx: taskirOfficeTx.rows,
      users: users.rows,
      expenses: expenses.rows,
      expenseNames: expenseNames.rows,
      reservations: reservations.rows,
      repairs: repairs.rows,
      returns: returns.rows,
      receipts: receipts.rows,
      assetClasses: assetClasses.rows,
      fixedAssets: fixedAssets.rows,
      depreciationSchedule: depreciationSchedule.rows,
      journal,
      goldLedger,
      currentUser: {
        id: req.auth.userId,
        name: req.auth.user.name,
        role: req.auth.role,
        branchId: req.auth.branchId,
        allowedPages: req.auth.allowedPages,
        roleConfig: req.auth.roleConfig,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
