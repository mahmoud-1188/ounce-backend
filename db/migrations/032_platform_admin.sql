-- 032_platform_admin.sql
--
-- لوحة أدمن المنصة (ounce-admin) — نقلُ مفاهيم صفحة «تصاريح الاشتراك»
-- المحلية الأولية إلى الخادم:
--
--   • «ترخيص شركة» (الاسم · الباقة · سقف الفروع · مدة الاشتراك) صار صفًّا
--     حقيقيًّا في stores — الأعمدة موجودة منذ 020_stores_multi_tenant.sql،
--     وهذه الهجرة تضيف فقط من يديرها (platform_admins) وسجلّ ما فعله.
--   • «سجل ما أصدرتَه — في هذا المتصفّح» صار platform_log في القاعدة: لا
--     يضيع بمسح بيانات المتصفّح، ويُصدَّر CSV من اللوحة.
--   • «نموذج تشغيل الفرع» (BRANCH_MODELS في النموذج الأولي) صار عمودًا في
--     branches — يُحفظ ويُعدَّل من اللوحة الآن، وتطبيقه على صلاحيات الشراء
--     والتكويد في تطبيق الفرع مرحلةٌ لاحقة (قرار المستخدم الصريح).

-- ── حسابات أدمن المنصة ──
-- منفصلة تمامًا عن store_users وusers: أدمن المنصة لا ينتمي لأي متجر
-- (راجع تعليق role في 022_store_users.sql). بلا RLS عمدًا — ليس جدولًا
-- معزولًا بفرع، ويُقرأ دائمًا عبر withoutBranch.
create table if not exists platform_admins (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  email          citext not null unique,
  password_hash  text not null,
  active         boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz default now()
);

-- ── سجل عمليات المنصة ──
-- كل إنشاءٍ وتعديلٍ وتجديدٍ وإيقاف يُكتب هنا في نفس معاملة الفعل نفسه —
-- فلا يوجد فعلٌ بلا أثر، ولا أثرٌ لفعلٍ لم يتم.
create table if not exists platform_log (
  id          bigserial primary key,
  admin_id    uuid references platform_admins(id),
  action      text not null,
  store_id    uuid references stores(id),
  branch_id   uuid references branches(id),
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists idx_platform_log_store on platform_log(store_id, created_at desc);
create index if not exists idx_platform_log_created on platform_log(created_at desc);

-- ── نموذج تشغيل الفرع ──
-- نفس المعرّفات الأربعة حرفيًّا من BRANCH_MODELS في النموذج الأولي:
--   full            فرعٌ كامل — يشتري ويُكوّد ويطبع بنفسه
--   coding_only_hq  التكويد في الإدارة — يشتري بموافقة، والبضاعة تُكوَّد في الرئيسي
--   sales_only      معرض بيعٍ فقط — يبيع ما يصله، لا يشتري ولا يُكوّد
--   approval_only   يُكوّد بموافقة — يُكوّد بنفسه لكن الشراء يحتاج اعتماد الإدارة
-- الافتراضي full: كل فرعٍ قائم يعمل اليوم كفرعٍ كامل، فلا يتغيّر سلوكه.
alter table branches add column if not exists operating_model text not null default 'full';
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'branches_operating_model_check'
  ) then
    alter table branches add constraint branches_operating_model_check
      check (operating_model in ('full', 'coding_only_hq', 'sales_only', 'approval_only'));
  end if;
end $$;
