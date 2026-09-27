-- أرصدة الموردين الافتتاحية (المرجع 5.2.0): ذهبٌ أو نقد، علينا له أو لنا عنده.
--   ذهبٌ علينا: 3100 ← 2110 بقيمته · ذهبٌ لنا عنده: 1320 ← 3100
--   نقدٌ علينا: 3100 ← 2120        · نقدٌ لنا عنده: 1320 ← 3100
--   ويُسجَّل في supplier_ledger فيظهر أوّل سطرٍ في كشف المورد.
create table if not exists supplier_openings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  supplier_id uuid not null references suppliers(id),
  kind text not null check (kind in ('gold','cash')),
  side text not null check (side in ('owed','due')),
  karat smallint check (karat in (24,22,21,18,14)),
  weight numeric(12,3) not null default 0,
  fine_weight numeric(12,3) not null default 0,
  amount numeric(14,2) not null default 0,
  note text,
  journal_entry_id uuid references journal_entries(id),
  void_entry_id uuid references journal_entries(id),
  voided_at timestamptz,
  voided_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint supplier_opening_has_value check (amount > 0),
  constraint supplier_opening_gold_weight check (kind = 'cash' or (weight > 0 and karat is not null))
);
create index if not exists idx_supplier_openings_supplier on supplier_openings(supplier_id);

alter table supplier_openings enable row level security;
drop policy if exists branch_isolation_supplier_openings on supplier_openings;
create policy branch_isolation_supplier_openings on supplier_openings
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

insert into posting_rules (op_type, label, rule) values
  ('supplier_opening', 'رصيد افتتاحي لمورد',
   '{"label": "رصيد افتتاحي لمورد", "cash": null, "note": "علينا: 3100 ← 2110 (ذهب) أو 2120 (نقد) · لنا عنده: 1320 ← 3100", "weight": null}'::jsonb),
  ('supplier_opening_void', 'إلغاء رصيد افتتاحي لمورد',
   '{"label": "إلغاء رصيد افتتاحي لمورد", "cash": null, "note": "عكس القيد الأصلي", "weight": null}'::jsonb)
on conflict (op_type) do nothing;
