-- 029_categories_write.sql
--
-- إغلاق فجوة حقيقية ثانية اكتُشفت أثناء إصلاح مسار التكويد: شاشة
-- "التصنيفات وطرق البيع" (CategoriesPage.jsx) كانت — ولا تزال قبل هذا —
-- محلية بالكامل (persist → window.storage، معرّفات cat_<slug>_<عشوائي>
-- من المتصفح) بلا أي مسار خلفي لإضافة/تعديل/حذف تصنيف في Postgres
-- إطلاقًا. categories موجودة في bootstrap للقراءة فقط (BACKEND_OWNED_FIELDS
-- في GoldInventoryApp.jsx)، فأي إضافة/تعديل/حذف من هذه الشاشة كان يظهر
-- فورًا ثم يختفي بصمت عند أول إعادة تحميل — بالضبط كحال المورّدين/
-- الأصناف/الدفعات قبل إصلاحها هذا الأسبوع.
--
-- ⚠ عمود جديد: sort_order. الشاشة تسمح بإعادة ترتيب التصنيفات يدويًّا
-- (أزرار أعلى/أسفل move()) — لا عمود ترتيب في الجدول الأصلي (كان الترتيب
-- ضمنيًّا بترتيب المصفوفة المحلية المخزَّنة). بلا هذا العمود سيعود ترتيب
-- categories من كل "select * from categories" عشوائيًّا فعليًّا (لا ضمان
-- ترتيب بلا order by صريح)، فتتغيّر مواضع التصنيفات في كل شاشة بيع/تكويد
-- بين كل تحميل صفحة — كسرٌ لتجربة البائع المعتاد على مواضعها.
alter table categories add column if not exists sort_order integer not null default 0;

-- ترقيم أولي بترتيب الإنشاء الحالي (id لا تاريخ إنشاء — الجدول الأصلي بلا
-- created_at) حفاظًا على ترتيب معقول للتصنيفات الموجودة فعلًا قبل هذه
-- الهجرة، بدل أن تُصبح جميعها 0 (نفس الترتيب) فجأة.
with ordered as (
  select id, row_number() over (partition by branch_id order by name) as rn
  from categories
)
update categories c set sort_order = o.rn
from ordered o
where o.id = c.id and c.sort_order = 0;

-- ⚠ إصلاح فجوة عزل حقيقية أخطر مكتشفة أثناء بناء هذه الهجرة نفسها:
-- migration 021_rls_coverage.sql طبّقت نفس سياسة RLS القياسية
-- (branch_id = current_setting('app.current_branch_id')::uuid) على كل
-- جدول في قائمتها بلا استثناء — بما فيها categories وexpense_names، وكلا
-- الجدولين الوحيدين اللذين يسمح تصميمهما أصلًا بـbranch_id = null كصفٍّ
-- "مشترك بين كل الفروع" (راجع تعليق العمود في schema.sql: "null = shared
-- across branches"). في PostgreSQL: null = uuid يُقيَّم NULL (لا true)،
-- فسياسة USING تستبعد هذه الصفوف من كل استعلام صمتًا — بصرف النظر عمّا
-- يطلبه استعلام التطبيق نفسه. والنتيجة: كل استعلامات الكود التي تكتب
-- صراحةً "branch_id = $1 or branch_id is null" (bootstrap.routes.js
-- لكلا الجدولين، items.routes.js وscrap.routes.js لـcategories) كانت
-- تُعيد الشطر الأول فقط دائمًا — أي تصنيف/اسم مصروف "مشترك" (بلا فرع
-- محدَّد) غير مرئي إطلاقًا لأي فرع، رغم أن الكود التطبيقي يطلبه صراحةً
-- ويفترض حصوله عليه.
--
-- الإصلاح: سياسة مخصَّصة لهذين الجدولين فقط تسمح بالصفّ إن كان يخصّ
-- الفرع الحالي أو كان مشتركًا (branch_id is null) — لا تُغيّر أي استعلام
-- تطبيقي (الكود يطلب هذا بالفعل)، فقط تُزيل الحاجز الذي كانت تفرضه
-- القاعدة بصمت فوق ما يطلبه الكود.
drop policy if exists branch_isolation_categories on categories;
create policy branch_isolation_categories on categories
  using (
    branch_id = current_setting('app.current_branch_id', true)::uuid
    or branch_id is null
  );

drop policy if exists branch_isolation_expense_names on expense_names;
create policy branch_isolation_expense_names on expense_names
  using (
    branch_id = current_setting('app.current_branch_id', true)::uuid
    or branch_id is null
  );
