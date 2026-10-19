-- قوالب المصروفات الثابتة (الإيجار والفواتير وما يسمّيه المحل): اسمٌ ومبلغٌ ويومٌ من الشهر.
-- يُذكَّر بالمستحقّ ويُسجَّل بضغطة مصروفًا عاديًّا بحدوده واعتماده؛ last_posted (YYYY-MM) يُكتب بعد نجاح القيد وحده.
create table if not exists fixed_expenses (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id),
  name            text not null,
  category        text not null,
  amount          numeric(14,2) not null check (amount > 0),
  day             int not null check (day between 1 and 28),
  funding_source  text not null,
  note            text,
  active          boolean not null default true,
  last_posted     text,
  last_expense_id uuid,
  created_by      uuid,
  created_at      timestamptz default now()
);
create index if not exists fixed_expenses_branch_idx on fixed_expenses(branch_id);
alter table fixed_expenses enable row level security;
drop policy if exists branch_isolation_fixed_expenses on fixed_expenses;
create policy branch_isolation_fixed_expenses on fixed_expenses
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
