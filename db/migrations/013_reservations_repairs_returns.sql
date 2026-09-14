-- Migration 013 — الحجوزات، الإصلاحات، والمرتجعات: الثلاثة كانت محلية
-- بالكامل (window.storage فقط) رغم وجود جداول أساسية لها أصلًا في
-- schema.sql — بلا أي endpoint يكتب فيها، فتختفي بعد إعادة تحميل الصفحة
-- تمامًا كسبب البلاغ الأصلي عن الخزنة. addToSource/deductFromSource
-- (المُستخدَمتان في الثلاثة لتحريك النقد) كانتا كذلك محليتين بالكامل.

-- ============================================================
-- 1. reservations — العربون والمتبقي والوصف ووسيلة الدفع، ووسم الإلغاء.
-- ============================================================

alter table reservations add column if not exists total numeric(14,2) not null default 0;
alter table reservations add column if not exists remaining numeric(14,2);
alter table reservations add column if not exists description text;
alter table reservations add column if not exists method text check (method in ('cash','network'));
alter table reservations add column if not exists business_day_id uuid references business_days(id);
alter table reservations add column if not exists cancelled_at timestamptz;
alter table reservations add column if not exists cancelled_by uuid references users(id);
alter table reservations add column if not exists refunded boolean not null default false;

-- ⚠ الفرونت إند يستخدم 'open' لا 'active' — القيد الأصلي كان يمنع أي
-- حجز جديد من الوصول لقاعدة البيانات إن لم يُصحَّح هنا أولًا.
alter table reservations drop constraint if exists reservations_status_check;
alter table reservations add constraint reservations_status_check
  check (status in ('open','completed','cancelled'));
alter table reservations alter column status set default 'open';

-- ⚠ القطعة المحجوزة يجب ألا تُباع لغيره — لم يوجد أي عمود يمثّل هذا على
-- مستوى قاعدة البيانات؛ الفرونت إند كان يعلّم `item.reservedFor` محليًا
-- فقط، فلا يمنع أي شيء فعليًا (بيع من جهاز آخر، أو بعد إعادة التحميل).
alter table items add column if not exists reserved_for uuid references reservations(id);

-- ============================================================
-- 2. repairs — إصلاح عميل بسيط (تكلفة + مكسب + مصدر تمويل)، لا يزال
-- منفصلًا عن دورة "تعديل وزن قطعة" الأكبر (handleRepairWeight) —
-- تلك تبقى محلية حاليًا، خارج نطاق هذي الهجرة.
-- ============================================================

alter table repairs add column if not exists description text;
alter table repairs add column if not exists cost numeric(14,2) not null default 0;
alter table repairs add column if not exists profit numeric(14,2) not null default 0;
alter table repairs add column if not exists funding_source text;
alter table repairs add column if not exists notes text;
alter table repairs add column if not exists customer_name text;
alter table repairs alter column weight_delta drop not null;
alter table repairs alter column weight_delta set default 0;

-- ============================================================
-- 2b. sale_lines — لا عمود ترتيب إطلاقًا (id عشوائي UUID لا يعكس ترتيب
-- الإدخال)، وbootstrap.routes.js يقرأها بلا ORDER BY على الإطلاق —
-- ترتيبها غير مضمون بين استدعاءين، فأي "فهرس سطر" يُرسَل من الفرونت إند
-- (كما تفعل شاشة استرجاع المبيعات) قد يشير لسطر مختلف فعليًا على الخادم.
-- اكتُشفت هذي الثغرة أثناء بناء endpoint المرتجعات (لازم ترتيبًا حتميًا
-- ليطابق الفهرس المُرسَل فعليًا نفس السطر الذي رآه المستخدم في الشاشة).
alter table sale_lines add column if not exists line_no integer;
-- ⚠ تعبئة رجعية بترتيب id الحالي — أفضل تقريب متاح للسجلات القديمة
-- (لا مصدر آخر لترتيبها الأصلي)؛ كل بيع جديد بعد هذي الهجرة يُثبَّت
-- line_no فعليًا وقت الإدراج (0،1،2...) فيطابق تمامًا ترتيب الإدخال.
with ordered as (
  select id, row_number() over (partition by sale_id order by id) - 1 as rn
  from sale_lines where line_no is null
)
update sale_lines set line_no = ordered.rn
  from ordered where sale_lines.id = ordered.id;
alter table sale_lines alter column line_no set not null;
alter table sale_lines alter column line_no set default 0;

-- ============================================================
-- 3. returns — سطور المرتجع الكاملة (لا مجموع فقط)، ومصدر الاسترداد.
-- ============================================================

alter table returns add column if not exists line_indexes jsonb;
alter table returns add column if not exists lines jsonb;
alter table returns add column if not exists full_return boolean not null default false;
alter table returns add column if not exists refund_source text;
alter table returns add column if not exists customer_id uuid references customers(id);
alter table returns add column if not exists customer_name text;
alter table returns alter column weight drop not null;
alter table returns alter column weight set default 0;

-- ============================================================
-- 3b. receipts — سطر سالب (خصم) يُستخدم لتعديل ذمة عميل عند مرتجع فاتورة
-- آجلة (لا يخرج نقد فعليًا، الفاتورة أصلًا لم تُحصَّل).
-- ============================================================

alter table receipts add column if not exists method text;
alter table receipts add column if not exists note text;
alter table receipts add column if not exists category text;
alter table receipts add column if not exists customer_name text;
alter table receipts alter column amount drop not null;

-- ============================================================
-- 4. Row Level Security — لم تكن مفعّلة على أي من الأربعة أصلًا.
-- ============================================================

alter table reservations enable row level security;
create policy branch_isolation_reservations on reservations
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table repairs enable row level security;
create policy branch_isolation_repairs on repairs
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table returns enable row level security;
create policy branch_isolation_returns on returns
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table receipts enable row level security;
create policy branch_isolation_receipts on receipts
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
