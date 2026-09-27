-- الإدارة المركزية (المرجع 5.2.0 — HqFiscalTab · HqRemoteStocktake · HqOrgChart):
--   ① إقفال الشهر: لقطةٌ ثابتة لأرقام الشهر (لكل حساب) باسم من أقفل — من الإدارة أو الفرع
--   ② جردٌ من الإدارة: العدّ يصل الفرع طلبًا، ومديره يطبّقه بمعالج الجرد نفسه أو يرفضه
--   ③ الهيكل الإداري: دورٌ وظيفيّ لموظفي الإدارة (رئيس المجلس · المدير العام · المالية · العمليات · النظام · المراجع)
create table if not exists period_closes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  period char(7) not null check (period ~ '^\d{4}-\d{2}$'),
  closed_at timestamptz not null default now(),
  closed_by text not null,
  closed_by_kind text not null check (closed_by_kind in ('store', 'branch')),
  snapshot jsonb not null default '{}'::jsonb,
  unique (branch_id, period)
);
alter table period_closes enable row level security;
drop policy if exists branch_isolation_period_closes on period_closes;
create policy branch_isolation_period_closes on period_closes using (branch_id = current_setting('app.current_branch_id', true)::uuid);

create table if not exists remote_stocktakes (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  ref text not null,
  counts jsonb not null,
  note text,
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected')),
  requested_by text not null,
  requested_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz,
  result jsonb
);
create index if not exists idx_remote_stocktakes_branch on remote_stocktakes(branch_id, status);
alter table remote_stocktakes enable row level security;
drop policy if exists branch_isolation_remote_stocktakes on remote_stocktakes;
create policy branch_isolation_remote_stocktakes on remote_stocktakes using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table store_users add column if not exists hq_role text;
alter table store_users drop constraint if exists store_users_hq_role_check;
alter table store_users add constraint store_users_hq_role_check check (hq_role is null or hq_role in
  ('chairman', 'gm', 'finance', 'operations', 'admin', 'auditor', 'hq_clerk', 'hq_coder', 'hq_warehouse'));
