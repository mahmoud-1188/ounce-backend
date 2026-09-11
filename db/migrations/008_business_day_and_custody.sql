-- Migration 008 — فتح/إقفال يوم العمل + عهدة الصندوق اليومي (daily custody).
--
-- ⚠ فجوة حقيقية اكتُشفت أثناء التحويل (لا افتراضًا): business_days
-- (schema.sql) كان جدولًا بلا أي INSERT/UPDATE عليه في كل الباك إند —
-- كل route كان *يقرأ* اليوم المفتوح فقط ليختم به سجلاته (سطر واحد
-- متكرر: `select id from business_days where status = 'open' ...`)، ولا
-- شيء يفتح يومًا جديدًا أو يُقفله. وبلا يوم مفتوح، /sales يرفض كل بيع
-- (409 no_open_business_day — موثَّق فعليًا في اختبار README السطر 118)،
-- فقاعدة بيانات جديدة لا يمكنها معالجة أي عملية بيع مطلقًا. seed.sql لا
-- يُدرج أي سطر business_days كذلك.
--
-- كذلك "العهدة اليومية" (عهدة درج الكاشير: عربون نقد يُعطى للبائع أول
-- اليوم، ويُقفل بعدّ فعلي وفرق) مفهوم منفصل تمامًا عن يوم العمل في
-- المرجع (handleOpenDailyCustody/handleCloseDailyCustody مستقلّان عن
-- handleOpenBusinessDay/handleCloseBusinessDay رغم أن فتح يوم العمل يفتح
-- عهدة تلقائيًا كأثر جانبي) — ولا جدول له في الباك إند إطلاقًا، فقط
-- scrap_custody (عهدة الكسر تحديدًا، مفهوم مختلف).

-- ============================================================
-- 1. business_days — أعمدة لقطة الإقفال (closing snapshot).
--
-- ⚠ قرار نطاق صريح: "الربح" (profit) في المرجع (saleProfitOf) يُحسب من
-- تكلفة الصنف + نصيبه من مصنعية الدفعة — بيانات تعيش أصلًا في bootstrap
-- المحمَّل لدى الفرونت إند (sales+items). حسابه هنا على الخادم يكرّر
-- منطق تسعير كامل ليس له مكان طبيعي في "إقفال يوم" — يبقى الربح محسوبًا
-- محليًا في الفرونت إند من نفس البيانات المخزَّنة أصلًا، ولقطة الإقفال هنا
-- تقتصر على ما يُشتق مباشرة ورخيصًا من دفاتر الحركة (عدّ/مجموع/رصيد لحظي).
-- ============================================================

alter table business_days add column if not exists note text;
alter table business_days add column if not exists close_note text;
alter table business_days add column if not exists sales_count integer;
alter table business_days add column if not exists sales_sum numeric(14,2);
alter table business_days add column if not exists expenses_sum numeric(14,2);
alter table business_days add column if not exists purchases_sum numeric(14,2);
alter table business_days add column if not exists cash_at_close numeric(14,2);
alter table business_days add column if not exists safe_at_close numeric(14,2);
alter table business_days add column if not exists custody_at_close numeric(14,2);
-- وزن الكسر المُعلَّق (لم يُستلَم/يُكسَّر/يُعتمَد بعد) وقت الإقفال —
-- تنبيهي فقط، لا يمنع الإقفال (مطابقةً لسلوك المرجع: suspendedScrap
-- معلومة تُعرض لا حاجز).
alter table business_days add column if not exists suspended_scrap_count integer;
alter table business_days add column if not exists suspended_scrap_weight numeric(12,3);

-- ============================================================
-- 2. daily_custody — عهدة الصندوق اليومي (عربون + عدّ + فرق)، مستقلة عن
-- business_days تمامًا (قد تُفتح/تُقفل عدّة مرات خلال نفس يوم العمل —
-- مناوبات متعددة مثلًا)، تمامًا كفلسفة safe_audits لكن لدرج الكاشير لا
-- الخزنة.
-- ============================================================

create table if not exists daily_custody (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id),
  ref               text unique not null,
  business_day_id   uuid references business_days(id),
  status            text not null default 'open' check (status in ('open','closed')),
  float_cash        numeric(14,2) not null default 0,
  float_network     numeric(14,2) not null default 0,
  counted_cash      numeric(14,2),
  counted_network   numeric(14,2),
  expected_cash     numeric(14,2),
  expected_network  numeric(14,2),
  variance_cash     numeric(14,2),
  variance_network  numeric(14,2),
  note              text,
  close_note        text,
  opened_by         uuid references users(id),
  opened_at         timestamptz not null default now(),
  closed_by         uuid references users(id),
  closed_at         timestamptz
);

alter table daily_custody enable row level security;
create policy branch_isolation_daily_custody on daily_custody
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

create index if not exists idx_daily_custody_open
  on daily_custody(branch_id) where status = 'open';
