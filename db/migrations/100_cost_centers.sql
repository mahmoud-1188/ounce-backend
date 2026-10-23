-- مراكز التكلفة كما في المرجع (BudgetsPage): معرض، ورشة، تسويق… يُنسب إليها المصروف عند تسجيله
-- ويُرى مجموع كل مركزٍ في شهره داخل الموازنات. الجدول في schema.sql منذ البداية (وعليه RLS من 021)،
-- فهنا ما ينقصه: الإيقاف وتاريخ الإنشاء، وعمود المركز في المصروف.
create table if not exists cost_centers (
  id         uuid primary key default gen_random_uuid(),
  branch_id  uuid not null references branches(id),
  name       text not null
);
alter table cost_centers add column if not exists active boolean not null default true;
alter table cost_centers add column if not exists created_at timestamptz not null default now();
create unique index if not exists cost_centers_branch_name on cost_centers(branch_id, lower(name));
alter table cost_centers enable row level security;
drop policy if exists branch_isolation_cost_centers on cost_centers;
create policy branch_isolation_cost_centers on cost_centers
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table expenses add column if not exists cost_center_id uuid references cost_centers(id);
create index if not exists expenses_cost_center on expenses(cost_center_id) where cost_center_id is not null;
