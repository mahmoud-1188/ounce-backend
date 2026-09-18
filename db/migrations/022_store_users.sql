-- 022_store_users.sql
--
-- المصادقة على مستوى المتجر (المركزي) — منفصلة تمامًا عن users (مستخدمي
-- الفرع) عمدًا، لا توسيعًا لجدول users بعمود nullable:
--
--   • مستخدم الفرع مربوطٌ بـbranch_id واحد وبنظام صلاحيات الشاشات
--     (allowed_tabs/allowed_more/roles) — مصمَّم لجهاز مشترك في المتجر
--     يُدخل PIN قصيرًا.
--   • مستخدم المركزي مربوطٌ بـstore_id (لا فرع بعينه — يرى كل فروع
--     متجره) ويحتاج دخولًا شخصيًا حقيقيًا (بريد + كلمة مرور) من أي جهاز،
--     لا صلاحيات شاشاتٍ من نفس نوع صلاحيات الفرع (شاشاته مختلفة كليًّا:
--     إدارة الفروع، التقرير المجمّع، لا بيعًا ولا مخزونًا).
--
-- خلطهما في جدولٍ واحد كان سيحتاج أعمدة nullable متعارضة المعنى
-- (branch_id فارغ يعني «مركزي»؟ أم خطأ بيانات؟) وشرطًا معقدًا في كل
-- استعلام يفرّق بينهما — جدولٌ منفصل أوضح وأأمن.

-- ⚠ citext (بريد بلا حساسية لحالة الأحرف عند المقارنة/الفهرس) — بنفس
-- نمط تفعيل pgcrypto في schema.sql (متاح لمستخدم القاعدة هنا أصلًا).
create extension if not exists citext;

create table store_users (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id),
  name          text not null,
  email         citext not null unique,
  password_hash text not null,
  -- ⚠ صاحب المتجر الأول عند التسجيل هو owner دائمًا؛ staff مقعدٌ لموظف
  -- إداري يضيفه صاحب المتجر لاحقًا بصلاحياتٍ أضيق (تُبنى حين تُطلب
  -- فعليًا — لا تُخمَّن هنا). لا دور "admin" هنا: أدمن المنصة جدولٌ
  -- ومصادقةٌ مختلفان تمامًا لا علاقة له بمتجرٍ بعينه.
  role          text not null default 'owner' check (role in ('owner', 'staff')),
  active        boolean not null default true,
  created_at    timestamptz default now()
);

create index if not exists idx_store_users_store on store_users(store_id);

