-- مراقبة الأعطال: الفرع يرسل بلاغ العطل تلقائيًّا والإدارة تستلمه — يُجمَّع العطل نفسه بعدّاد بدل سطرٍ لكل مرّة
create table if not exists client_errors (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  fingerprint text not null,
  message text not null,
  stack text,
  url text,
  app_version text,
  user_agent text,
  last_user_id uuid references users(id),
  count integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_note text,
  unique (branch_id, fingerprint)
);
create index if not exists idx_client_errors_open on client_errors (branch_id, last_seen desc) where resolved_at is null;
alter table client_errors enable row level security;
drop policy if exists branch_isolation_client_errors on client_errors;
create policy branch_isolation_client_errors on client_errors
  using (branch_id = (current_setting('app.current_branch_id', true))::uuid);
