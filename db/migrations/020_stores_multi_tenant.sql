-- 020_stores_multi_tenant.sql
--
-- الخطوة الأولى نحو منصّة متعدّدة المستأجرين (multi-tenant): طبقة "متجر"
-- فوق الفروع. كل الجداول الأخرى (المبيعات، القيود، المخزون...) مرتبطة
-- بـbranch_id فعلًا وتُعزل بـRLS على مستوى القاعدة (branch_isolation_*
-- policies في schema.sql) — فربط الفرع بمتجر يكفي لعزل المتاجر عن بعضها
-- تلقائيًّا بلا لمس أي RLS policy موجودة: فرعٌ لا يخرج من عزل فرعه، وربطه
-- بمتجرٍ لا يغيّر ذلك، فقط يُضيف مستوى تجميع فوقه.
--
-- ⚠ لا تُبنى صفحة الإدارة المركزية ولا الأدمن هنا — هذه فقط الطبقة التي
-- يقوم عليها كل شيء لاحق (سقف الفروع، عزل الاشتراك، مصادقة مستخدم مركزي).

create table stores (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  plan            text not null default 'central' check (plan in ('central', 'branch_only')),
  max_branches    integer not null default 1 check (max_branches >= 1),
  -- ⚠ null = بلا انتهاء (نفس اتفاقية expiresAt في مرجع العميل لتصاريح
  -- الاشتراك: صفرٌ/عدمٌ يعني اشتراكًا دائمًا لا محدودًا).
  subscription_expires_at  timestamptz,
  status          text not null default 'active' check (status in ('active', 'suspended', 'expired')),
  created_at      timestamptz default now()
);

-- الفرع الآن تابعٌ لمتجر. نُبقيها nullable مؤقتًا لحظة الإضافة فقط
-- (الفروع القائمة لا متجر لها بعد) ثم نملأها فورًا أدناه ونجعلها إلزامية.
alter table branches add column store_id uuid references stores(id);

-- ⚠ القرار المتفق عليه صراحةً: الفروع/المستخدمون الحاليون في هذه القاعدة
-- يصبحون أول متجر حقيقي على المنصة، لا بيانات تجريبية تُحذف لاحقًا.
-- سقف الفروع هنا يُحسب من العدد الفعلي الحالي (لا رقمٍ ثابتٍ قد يقل عن
-- الواقع) حتى لا يُحظر إنشاء فرعٍ جديدٍ خطأً فور تشغيل هذه الهجرة.
do $$
declare
  v_store_id uuid;
  v_branch_count integer;
begin
  select count(*) into v_branch_count from branches;

  insert into stores (name, plan, max_branches, status)
  values ('Metal Merchant', 'central', greatest(v_branch_count, 1), 'active')
  returning id into v_store_id;

  update branches set store_id = v_store_id where store_id is null;
end $$;

alter table branches alter column store_id set not null;

create index if not exists idx_branches_store on branches(store_id);

-- ⚠ لا يوجد بعد أي جدول مستخدمين "مركزيين" (مربوطين بمتجر لا بفرع) — هذا
-- يحتاج تصميم مصادقة منفصل (طبقة auth تختلف عن users.branch_id الحالية)
-- ويُبنى في هجرة لاحقة بعد الاتفاق على شكله، لا يُخمَّن هنا.
