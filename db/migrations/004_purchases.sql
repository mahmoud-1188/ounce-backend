-- Migration 004 — طبقة الشراء من مورد (POST /api/purchases).
--
-- الجداول اللي كانت موجودة (lots, taskir_office_tx, safe_gold_tx,
-- suppliers, scrap_items, taskir_offices) اتصممت مبكرًا بأعمدة أساسية فقط،
-- قبل ما نوصل لتفاصيل شاشة الشراء الفعلية (AddPurchaseModal.jsx). هذي
-- الهجرة تكمّلها بكل ما يحتاجه الـendpoint فعليًا، مبنية بالكامل على
-- posting_rules المزروعة أصلًا من chart.js (purchase_cash, purchase_network,
-- purchase_deferred, purchase_office, purchase_scrap_pay).

-- ============================================================
-- 1. purchases — رأس عملية الشراء (سطر واحد لكل عملية شراء، بصرف النظر
--    عن عدد العيارات بداخلها).
-- ============================================================

create table purchases (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  ref text not null unique,
  supplier_id uuid not null references suppliers(id),
  business_day_id uuid references business_days(id),
  payment_method text not null check (payment_method in ('safe_cash','safe_network','scrap','office','deferred')),
  office_id uuid references taskir_offices(id),
  scrap_karat smallint check (scrap_karat in (24,22,21,18,14)),
  scrap_weight numeric(12,3) not null default 0,
  -- في الآجل فقط: هل تُسدَّد الأجور نقدًا من الخزنة فورًا رغم تأجيل الذهب؟
  -- (نفس toggle "سداد الأجور نقدًا الآن" في AddPurchaseModal). لبقية طرق
  -- الدفع القيمة بلا أثر.
  pay_fees_now boolean not null default true,
  invoice_pending boolean not null default true,
  notes text,
  subtotal numeric(14,2) not null,        -- إجمالي تكلفة الذهب (بدون أجور)
  workmanship_total numeric(14,2) not null default 0,
  grand_total numeric(14,2) not null,     -- subtotal + workmanship_total
  total_weight numeric(12,3) not null,
  total_fine_weight numeric(12,3) not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint purchases_office_requires_office_id
    check (payment_method != 'office' or office_id is not null),
  constraint purchases_scrap_requires_weight
    check (payment_method != 'scrap' or scrap_weight > 0)
);

create index idx_purchases_branch on purchases(branch_id);
create index idx_purchases_supplier on purchases(supplier_id);

-- ============================================================
-- 2. lots — تمديد الجدول الموجود. كل سطر = عيار واحد ضمن عملية شراء
--    (القطعة الأساسية اللي items.lot_id يشير إليها لاحقًا وقت التكويد).
--
-- ⚠ إزالة قيد lots_ref_key الفريد: الشراء الواحد في المرجع (createLotCore)
-- يُنتج عدة أسطر (عيار لكل سطر) تتشارك نفس purchaseRef فعليًا — قيد
-- الفرادة على ref كان سيمنع أي شراء متعدد العيارات من الحفظ أصلًا. الفرادة
-- الحقيقية أصبحت على id (مفتاح أساسي) مع ربط صريح بالشراء عبر purchase_id.
-- ============================================================

alter table lots drop constraint if exists lots_ref_key;

alter table lots add column if not exists purchase_id uuid references purchases(id);
alter table lots add column if not exists karat smallint check (karat in (24,22,21,18,14));
alter table lots add column if not exists weight numeric(12,3);
alter table lots add column if not exists cost_per_gram numeric(14,4);
alter table lots add column if not exists gold_cost numeric(14,2);
alter table lots add column if not exists workmanship_total numeric(14,2) not null default 0;
alter table lots add column if not exists total_cost numeric(14,2);
alter table lots add column if not exists status text not null default 'open' check (status in ('open','closed'));
-- الوزن الذي دخل المخزون فعليًا وقت التكويد (يُملأ لاحقًا عند إقفال الدفعة؛
-- NULL يعني لم تُقفل بعد). الفرق عن weight (المشترى) = هالك أو فائض.
alter table lots add column if not exists entered_weight numeric(12,3);
alter table lots add column if not exists wastage_weight numeric(12,3) not null default 0;
alter table lots add column if not exists surplus_weight numeric(12,3) not null default 0;
alter table lots add column if not exists closed_by uuid references users(id);
alter table lots add column if not exists closed_at timestamptz;

create index if not exists idx_lots_purchase on lots(purchase_id);

-- ============================================================
-- 3. supplier_ledger — دفتر التزامات الموردين (البعدان مستقلان دائمًا:
--    ذهب مستحق بالجرام الصافي، وأجور مستحقة بالعملة — تمامًا كما يحذّر
--    تعليق purchase_deferred في chart.js: "لا يُخلطان"). دفتر تراكمي
--    (increase/decrease) بنفس فلسفة gold_ledger_entries/cash_tx، لا عمود
--    رصيد مخزَّن — الرصيد يُحسب بالجمع وقت الحاجة.
-- ============================================================

create table supplier_ledger (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  supplier_id uuid not null references suppliers(id),
  business_day_id uuid references business_days(id),
  direction text not null check (direction in ('increase','decrease')),
  gold_fine_grams numeric(12,3) not null default 0,
  fees_amount numeric(14,2) not null default 0,
  ref_table text,
  ref_id uuid,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint supplier_ledger_needs_a_dimension
    check (gold_fine_grams > 0 or fees_amount > 0)
);

create index idx_supplier_ledger_supplier on supplier_ledger(supplier_id);

-- ============================================================
-- 4. taskir_office_tx — تمديد: احتجنا العيار (لحساب الوزن الصافي لاحقًا)
--    ومرجع تتبع العملية المصدر، لم يكونا موجودين.
--
-- اصطلاح الاتجاه (لم يكن موثّقًا): 'in' = التزام تجاه المكتب يزيد (تسكير
-- شراء جديد — هذا الملف)، 'out' = يقل (تسوية/سداد لاحقًا — settle_office_*
-- في chart.js). نفس منطق حركة الدَّين لا حركة الذهب الفعلية.
-- ============================================================

alter table taskir_office_tx add column if not exists karat smallint check (karat in (24,22,21,18,14));
alter table taskir_office_tx add column if not exists business_day_id uuid references business_days(id);
alter table taskir_office_tx add column if not exists ref_table text;
alter table taskir_office_tx add column if not exists ref_id uuid;
alter table taskir_office_tx add column if not exists note text;

-- ============================================================
-- 5. Row Level Security — نفس النمط في schema.sql، نسدّ به جزءًا من
--    TODO الموجود هناك لكل جدول نلمسه في هذي الطبقة.
-- ============================================================

alter table purchases enable row level security;
create policy branch_isolation_purchases on purchases
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table lots enable row level security;
create policy branch_isolation_lots on lots
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table supplier_ledger enable row level security;
create policy branch_isolation_supplier_ledger on supplier_ledger
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table suppliers enable row level security;
create policy branch_isolation_suppliers on suppliers
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table safe_gold_tx enable row level security;
create policy branch_isolation_safe_gold_tx on safe_gold_tx
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table taskir_offices enable row level security;
create policy branch_isolation_taskir_offices on taskir_offices
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table taskir_office_tx enable row level security;
create policy branch_isolation_taskir_office_tx on taskir_office_tx
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
