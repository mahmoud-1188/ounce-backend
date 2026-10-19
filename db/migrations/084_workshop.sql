-- الورشة ونسبة الهدر من الميزان: يُصرف ذهبٌ للورشة بوزنه، ويُستلم المشغول والمردود بوزنهما، والهدر يُحسب بالصافي.
-- المسموح منه بعقد الورشة يُقفل وحده، والزائد يعتمده غير من سجّله (الإدارة حين يكون المدير هو المسجِّل).
-- كل وزنةٍ تحمل دليلها: من الميزان بقراءته، أو مكتوبةٌ بسببٍ إلزامي.
insert into accounts (code, name, parent_code, unit, nature, statement, is_group) values
  ('1250', 'ذهب لدى الورشة', '1200', 'both', 'debit', 'balance', false)
on conflict (code) do nothing;
insert into weight_accounts (account_code) select '1250' where not exists (select 1 from weight_accounts where account_code = '1250');
insert into accounts (code, name, parent_code, unit, nature, statement, is_group)
select '5350', 'هدر الورشة — المسموح', coalesce((select parent_code from accounts where code = '5330'), '5000'), 'currency', 'debit', 'income', false
on conflict (code) do nothing;
insert into accounts (code, name, parent_code, unit, nature, statement, is_group)
select '5360', 'هدر الورشة — الزائد المعتمد', coalesce((select parent_code from accounts where code = '5330'), '5000'), 'currency', 'debit', 'income', false
on conflict (code) do nothing;

create table if not exists workshop_jobs (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  ref text not null,
  workshop_name text not null,
  karat smallint not null check (karat in (24, 22, 21, 18, 14)),
  issued_weight numeric(12,3) not null,
  allowed_pct numeric(6,3) not null default 0,
  basis text not null default 'in' check (basis in ('in', 'out')),
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  worked_weight numeric(12,3),
  returned_weight numeric(12,3),
  wastage_fine numeric(12,3),
  allowed_fine numeric(12,3),
  excess_fine numeric(12,3),
  price24 numeric(14,4),
  evidence jsonb not null default '{}'::jsonb,
  note text,
  approval_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id),
  unique (branch_id, ref)
);
alter table workshop_jobs enable row level security;
drop policy if exists branch_isolation_workshop_jobs on workshop_jobs;
create policy branch_isolation_workshop_jobs on workshop_jobs
  using (branch_id = (current_setting('app.current_branch_id', true))::uuid);

insert into approval_rules (id, label, threshold, approver_role) values
  ('workshop_wastage', 'هدر ورشة فوق المسموح', 0, 'manager')
on conflict (id) do nothing;
insert into posting_rules (op_type, label, rule) values
  ('workshop_wastage', 'هدر الورشة', '{"cash": {"debit": "5350", "credit": "1220"}, "weight": {"from": "1250", "to": null}}')
on conflict (op_type) do nothing;
