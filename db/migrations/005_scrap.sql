-- Migration 005 — دورة الكسر الكاملة (شراء → استلام مسؤول → تكسير | إرسال
-- → تقييم → اعتماد → استلام نهائي) + إيداع احتياطي للخزنة.
--
-- جداول scrap_items/scrap_requests/scrap_custody/scrap_surplus كانت
-- هياكل أساسية فقط من مرحلة تصميم مبكرة. هذي الهجرة تكمّلها.

-- ============================================================
-- 1. scrap_items — إضافة كل حقول الشراء والتكسير والتسوية المطلوبة.
-- ============================================================

alter table scrap_items add column if not exists customer_name text;
alter table scrap_items add column if not exists description text;
alter table scrap_items add column if not exists gross_weight numeric(12,3);
alter table scrap_items add column if not exists stones_margin_est numeric(12,3) not null default 0;
alter table scrap_items add column if not exists price_per_gram numeric(14,4);
alter table scrap_items add column if not exists total_paid numeric(14,2);
alter table scrap_items add column if not exists payment_method text check (payment_method in ('cash','network'));
-- الرصيد القابل للانقسام المتبقي من هذي القطعة بعد وصولها in_safe —
-- يُستهلك جزئيًا عند السداد لمورد (purchases.routes.js)، لا دفعة واحدة.
-- ⚠ قرار اتُّخذ صراحةً بعد سؤالك: وعاء قابل للانقسام بالوزن لكل عيار،
-- لا مطابقة قطعة كاملة كما في وحدات البيع.
alter table scrap_items add column if not exists weight_remaining numeric(12,3);
alter table scrap_items add column if not exists actual_stones_weight numeric(12,3);
alter table scrap_items add column if not exists break_variance numeric(12,3);
alter table scrap_items add column if not exists refined boolean not null default false;
alter table scrap_items add column if not exists request_id uuid references scrap_requests(id);
alter table scrap_items add column if not exists sent_by uuid references users(id);
alter table scrap_items add column if not exists sent_at timestamptz;
alter table scrap_items add column if not exists received_by uuid references users(id);
alter table scrap_items add column if not exists received_at timestamptz;
alter table scrap_items add column if not exists broken_by uuid references users(id);
alter table scrap_items add column if not exists broken_at timestamptz;
alter table scrap_items add column if not exists confirmed_by uuid references users(id);
alter table scrap_items add column if not exists confirmed_at timestamptz;

-- ⚠ 'pending_break' (له فصوص، بانتظار التكسير) و'received' (استلمه
-- مسؤول الكسر) كانا ناقصين من القيد الأصلي — بدونهما لا يمكن تمثيل
-- مسار مسؤول الكسر إطلاقًا.
alter table scrap_items drop constraint if exists scrap_items_stage_check;
alter table scrap_items add constraint scrap_items_stage_check
  check (stage in ('pending_break','received','in_box','sent','assessed','approved','in_safe','used'));

alter table scrap_items add constraint scrap_items_karat_est_check
  check (karat_est is null or karat_est in (24,22,21,18,14));
alter table scrap_items add constraint scrap_items_karat_final_check
  check (karat_final is null or karat_final in (24,22,21,18,14));

create index if not exists idx_scrap_items_request on scrap_items(request_id);

-- ============================================================
-- 2. scrap_requests — أعمدة مُهيكَلة لكل ما يمكن الاستعلام عنه؛
-- payload (JSONB، موجود أصلًا) يحمل مصفوفات الأسطر لكل مرحلة
-- (sentLines/assessedLines/confirmedLines) بنفس أسلوب posting_rules.rule
-- الموجود أصلًا في هذا المشروع.
-- ============================================================

alter table scrap_requests add column if not exists business_day_id uuid references business_days(id);
alter table scrap_requests add column if not exists sent_fine numeric(12,3);
alter table scrap_requests add column if not exists assessed_fine numeric(12,3);
alter table scrap_requests add column if not exists confirmed_fine numeric(12,3);
alter table scrap_requests add column if not exists variance numeric(12,3);
alter table scrap_requests add column if not exists note text;
alter table scrap_requests add column if not exists assess_note text;
alter table scrap_requests add column if not exists assessed_by uuid references users(id);
alter table scrap_requests add column if not exists assessed_at timestamptz;
alter table scrap_requests add column if not exists approved_by uuid references users(id);
alter table scrap_requests add column if not exists approved_at timestamptz;
alter table scrap_requests add column if not exists received_by uuid references users(id);
alter table scrap_requests add column if not exists received_at timestamptz;

alter table scrap_requests drop constraint if exists scrap_requests_status_check;
alter table scrap_requests add constraint scrap_requests_status_check
  check (status in ('pending','assessed','approved','received','rejected'));

-- ============================================================
-- 3. Row Level Security
-- ============================================================

alter table scrap_items enable row level security;
create policy branch_isolation_scrap_items on scrap_items
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table scrap_requests enable row level security;
create policy branch_isolation_scrap_requests on scrap_requests
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table scrap_custody enable row level security;
create policy branch_isolation_scrap_custody on scrap_custody
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table scrap_surplus enable row level security;
create policy branch_isolation_scrap_surplus on scrap_surplus
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
