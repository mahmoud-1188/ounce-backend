-- قطعةٌ مسجّلة مباعة وُجدت على الرفّ أثناء الجرد — بند مراجعة، لا زيادة آلية
-- (قرار المالك 2026-09-29 — المرجع 5.2.0 «SoldFoundCard»).
--
-- كان المسح يرفضها («ليست في هذا النطاق») والعدّ اليدوي يضيفها زيادةً بقيد.
-- الآن تُحفظ بفاتورتها وتاريخها وعميلها ومن قرأها ومتى، بلا قيدٍ ولا قطعة،
-- وتبقى «مباعة» فلا تُباع ثانيةً — حتى يقرّر المدير بسببٍ مكتوب:
--   sale_ok  البيع صحيح — القطعة ليست لنا (بلا قيد؛ «أمانة بانتظار الاستلام» اختياريًّا)
--   returned إرجاع البيع (مرتجع سطر الفاتورة بمساره المعتاد، ويُربط هنا برقمه)
--   added    إضافة كقطعة جديدة (زيادة جرد بتكلفة الصنف في الدفترين برمزٍ جديد)
create table if not exists stocktake_sold_found (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  unit_id       uuid references item_units(id),
  unit_code     text not null,
  item_id       uuid references items(id),
  sale_id       uuid references sales(id),
  sale_ref      text,
  sale_date     timestamptz,
  customer_name text,
  found_by      uuid references users(id),
  found_at      timestamptz not null default now(),
  source        text not null default 'scan',
  status        text not null default 'pending'
                check (status in ('pending', 'sale_ok', 'returned', 'added')),
  held_for_customer boolean not null default false,
  reason        text,
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  return_id     uuid references returns(id),
  new_unit_code text,
  journal_entry_id uuid
);
-- بندٌ معلّقٌ واحد لكل قطعة: قراءتها مرّتين لا تكرّر البند
create unique index if not exists uq_sold_found_pending
  on stocktake_sold_found (branch_id, unit_code) where status = 'pending';
create index if not exists idx_sold_found_branch on stocktake_sold_found (branch_id, status, found_at desc);

alter table stocktake_sold_found enable row level security;
drop policy if exists branch_isolation_stocktake_sold_found on stocktake_sold_found;
create policy branch_isolation_stocktake_sold_found on stocktake_sold_found
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
