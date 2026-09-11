import { Router } from "express";
import { withBranch } from "../db.js";
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
 * المستخدمون). جداول أخرى موجودة في الـschema (رواتب، أصول ثابتة،
 * ميزانيات، GOSI...) غير موصولة بأي منطق باك إند بعد — ستُضاف لهذا
 * الـendpoint حين تُبنى فعليًا، لا نظريًا.
 *
 * ⚠ حساسية البيانات: قائمة المستخدمين هنا مُصغَّرة (بلا pin_hash وبلا
 * salary) خلافًا لـGET /api/users الكاملة (المحمية بصلاحية "access" فقط)
 * — لأن bootstrap يُحمَّل لكل مستخدم مسجَّل دخول بصرف النظر عن دوره، وراتب
 * الموظفين ليس بيانًا يجب أن يراه كل مستخدم.
 */
router.get("/bootstrap", async (req, res, next) => {
  try {
    const branchId = req.auth.branchId;

    const data = await withBranch(branchId, async (client) => {
      // ⚠ إصلاح حقيقي اكتُشف أثناء أول تشغيل فعلي: عميل pg واحد
      // (client) لا يقبل تشغيل استعلامات متزامنة عبر Promise.all —
      // كل استعلام يُشغَّل بالتتابع (await) لا بالتوازي. لا مشكلة أداء
      // حقيقية هنا: كلها استعلامات فهرسة بسيطة على فرع واحد ضمن
      // معاملة قصيرة العمر أصلًا.
      const branch = await client.query(`select id, ref, name from branches where id = $1`, [branchId]);
      // ⚠ توسيع حقيقي: كان يُحمَّل عمود مُصغَّر لآخر يوم فقط، لكن WorkDayPage
      // في المرجع تعرض أيضًا سجل "الأيام السابقة" (ref، فتح/إقفال، مبيعات،
      // ربح، مصاريف) من businessDays نفسها — لا مصدر آخر له. نحمّل آخر 90
      // يومًا (سنة عمل تقريبًا) بكل أعمدة اللقطة، لا عمودًا مُصغَّرًا للأحدث فقط.
      const businessDay = await client.query(
        `select * from business_days
           where branch_id = $1 order by opened_at desc limit 90`,
        [branchId]
      );
      // ⚠ إصلاح حقيقي: العمود الصحيح locked_by لا started_by (لم يُتحقق
      // من الـschema فعليًا قبل أول تشغيل — درس متكرر في هذا المشروع).
      const stocktakeLock = await client.query(
        `select locked, locked_by, locked_at from stocktake_locks where branch_id = $1`,
        [branchId]
      );
      // ⚠ آخر 60 سجل عهدة صندوق يومي — تكفي لعرض الحالي + تاريخ قريب في
      // WorkDayPage بلا حمل bootstrap بسجل طويل لا يُعرض عمليًا.
      const dailyCustody = await client.query(
        `select * from daily_custody where branch_id = $1 order by opened_at desc limit 60`,
        [branchId]
      );
      const branchSettings = await client.query(
        `select tax_enabled, tax_rate, card_fees from branch_settings where branch_id = $1`,
        [branchId]
      );
      // فئات مشتركة بين الفروع (branch_id يمكن أن يكون null) + فئات هذا الفرع تحديدًا.
      const categories = await client.query(`select * from categories where branch_id = $1 or branch_id is null`, [branchId]);
      const items = await client.query(`select * from items where branch_id = $1 order by date_added desc`, [branchId]);
      const itemUnits = await client.query(
        `select u.* from item_units u join items i on i.id = u.item_id
           where i.branch_id = $1`,
        [branchId]
      );
      const customers = await client.query(`select * from customers where branch_id = $1 order by name`, [branchId]);
      const suppliers = await client.query(`select * from suppliers where branch_id = $1 order by name`, [branchId]);
      const sales = await client.query(`select * from sales where branch_id = $1 order by date desc limit 500`, [branchId]);
      const saleLines = await client.query(
        `select sl.* from sale_lines sl join sales s on s.id = sl.sale_id
           where s.branch_id = $1`,
        [branchId]
      );
      const lots = await client.query(`select * from lots where branch_id = $1 order by date desc`, [branchId]);
      const scrapItems = await client.query(`select * from scrap_items where branch_id = $1 order by created_at desc limit 500`, [branchId]);
      const scrapRequests = await client.query(`select * from scrap_requests where branch_id = $1 order by created_at desc limit 200`, [branchId]);
      const cashTx = await client.query(`select * from cash_tx where branch_id = $1 order by created_at desc limit 500`, [branchId]);
      const safeGoldTx = await client.query(`select * from safe_gold_tx where branch_id = $1 order by created_at desc limit 500`, [branchId]);
      const safeAudits = await client.query(`select * from safe_audits where branch_id = $1 order by created_at desc limit 100`, [branchId]);
      const goldIssues = await client.query(`select * from gold_issues where branch_id = $1 order by created_at desc limit 200`, [branchId]);
      const taskirOffices = await client.query(`select * from taskir_offices where branch_id = $1 order by name`, [branchId]);
      const taskirEntries = await client.query(`select * from taskir_entries where branch_id = $1 order by created_at desc limit 200`, [branchId]);
      const taskirOfficeTx = await client.query(`select * from taskir_office_tx where branch_id = $1 order by created_at desc limit 200`, [branchId]);
      const users = await client.query(
        `select u.id, u.name, u.ref, u.role, u.can_use_ai, u.allowed_pages, u.active, u.created_at,
                r.allowed_tabs, r.allowed_more
           from users u join roles r on r.id = u.role
          where u.branch_id = $1 and u.active = true
          order by u.name`,
        [branchId]
      );
      const expenses = await client.query(
        `select * from expenses where branch_id = $1 order by created_at desc limit 500`,
        [branchId]
      );
      const expenseNames = await client.query(
        `select * from expense_names where branch_id = $1 or branch_id is null order by name`,
        [branchId]
      );

      return {
        branch: branch.rows[0] || null,
        // ⚠ businessDay (مفرد) يبقى بشكله الأصلي (أحدث سجل فقط) — لا يُكسَر
        // عقد المستهلك الحالي في bootstrap.routes.js/normalize.js. businessDays
        // (جمع) إضافة جديدة: قائمة كاملة بكل أعمدة اللقطة، لعرض سجل "الأيام
        // السابقة" في WorkDayPage الذي لا مصدر آخر له.
        businessDay: businessDay.rows[0] || null,
        businessDays: businessDay.rows,
        stocktakeLock: stocktakeLock.rows[0] || null,
        dailyCustody: dailyCustody.rows,
        settings: branchSettings.rows[0] || { tax_enabled: true, tax_rate: 0.15, card_fees: {} },
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
      };
    });

    res.json({
      ...data,
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
