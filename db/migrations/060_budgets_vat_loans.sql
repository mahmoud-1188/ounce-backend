-- الموازنات (المرجع 5.2.0: BudgetsPage) · إقرار ضريبة القيمة المضافة · سلف الموظفين بالأقساط · تقييم الأداء
-- ⚠ جدول budgets القديم (لكل مركز تكلفة، غير مستعمَل) يبقى كما هو — موازنة الحسابات في account_budgets
create table if not exists account_budgets (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  period char(7) not null check (period ~ '^\d{4}-\d{2}$'),
  account_code text not null references accounts(code),
  amount numeric(14,2) not null check (amount >= 0),
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  unique (branch_id, period, account_code)
);
alter table account_budgets enable row level security;
drop policy if exists branch_isolation_account_budgets on account_budgets;
create policy branch_isolation_account_budgets on account_budgets using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- السلفة تُقسَّط على أشهر: يُخصم من كل مسيّر قسطٌ واحد حتى تُسدَّد
alter table expenses add column if not exists installments int not null default 1 check (installments between 1 and 60);
alter table expenses add column if not exists repaid numeric(14,2) not null default 0;

create table if not exists hr_evaluations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  user_id uuid not null references users(id),
  period char(7) not null check (period ~ '^\d{4}-\d{2}$'),
  score int not null check (score between 1 and 5),
  criteria jsonb not null default '{}'::jsonb,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (branch_id, user_id, period)
);
alter table hr_evaluations enable row level security;
drop policy if exists branch_isolation_hr_evaluations on hr_evaluations;
create policy branch_isolation_hr_evaluations on hr_evaluations using (branch_id = current_setting('app.current_branch_id', true)::uuid);

update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["budgets","vatReturn"]'::jsonb) v) where id in ('manager', 'accountant');
