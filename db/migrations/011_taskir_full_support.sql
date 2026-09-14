-- taskir_entries كانت مصمَّمة مبكرًا بهيكل أساسي فقط (id, branch_id,
-- office_id, weight, karat, business_day_id, created_by, created_at) —
-- لا يمثّل سجل تسكير حقيقي كما ينتجه AddTaskirForm.jsx/handleAddTaskir
-- في الفرونت إند (راجع تعليق مماثل في 010_expenses_write_support.sql).
--
-- الأهم: لم يكن هناك عمود supplier_id إطلاقًا رغم أن التسكير هو أصلًا
-- "تسوية مستحقات الموردين" (تعليق TaskiratPage.jsx) — سجل تسكير بلا
-- مورد لا معنى له. هذا أخطر فجوة اكتُشفت في تدقيق هذه الميزة.
alter table taskir_entries
  add column if not exists ref text,
  add column if not exists supplier_id uuid references suppliers(id),
  add column if not exists gold_source text check (gold_source in ('scrap','purchased')),
  add column if not exists price_per_gram numeric(14,2),
  add column if not exists gold_cost numeric(14,2) not null default 0,
  add column if not exists workmanship_amount numeric(14,2) not null default 0,
  add column if not exists funding_source text,
  add column if not exists total_cash_paid numeric(14,2) not null default 0,
  add column if not exists notes text,
  add column if not exists invoice_attach_id text;

-- ref فريد لكل فرع فقط بعد ما الصفوف الحالية (إن وُجدت) تاخد قيمة —
-- نفس أسلوب unique index جزئي مستخدم في scrap_items.ref، بدل unique
-- constraint مباشر يفشل لو الجدول فيه صفوف قديمة بلا ref.
update taskir_entries set ref = 'TSK-LEGACY-' || substr(id::text, 1, 8) where ref is null;
alter table taskir_entries alter column ref set not null;
create unique index if not exists idx_taskir_entries_ref on taskir_entries(branch_id, ref);

alter table taskir_entries enable row level security;
drop policy if exists branch_isolation_taskir_entries on taskir_entries;
create policy branch_isolation_taskir_entries on taskir_entries
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

create index if not exists idx_taskir_entries_supplier on taskir_entries(supplier_id);
create index if not exists idx_taskir_entries_business_day on taskir_entries(business_day_id);

-- taskir_office_tx: migration 004 أضافت بالفعل karat/business_day_id/
-- ref_table/ref_id/note (راجع تعليقها). الناقص الوحيد المكتشف هنا هو
-- kind — تمييز سطر "ذهب" (سداد بوزن) عن سطر "نقد" (سداد بمبلغ)، مطلوب
-- لأن TaskirOfficesPage.jsx (وضع السداد gold|cash) لا يمكن تمثيله
-- بعمود weight/amount وحدهما بلا تمييز صريح لنوع الحركة.
alter table taskir_office_tx
  add column if not exists kind text check (kind in ('gold','cash'));

-- سطور موجودة مسبقًا (إن وُجدت) من purchases.routes.js كانت دائمًا
-- "ذهب" (وزن دومًا موجود، لا cash مرتبط بها هناك) — تُصنَّف بأثر رجعي.
update taskir_office_tx set kind = 'gold' where kind is null;
