-- ما مضى بلا موافقة (المرجع ApprovalsPage «ما مضى بلا موافقةٍ بتفويض الإدارة»):
-- عمليةٌ فوق حدّ الاعتماد مضت لأن الإدارة فوّضت الفرع «بلا موافقات» أو جعلت نوعها «بلا موافقة»
-- تُدوَّن هنا بمبلغها ومن أجراها ومتى — فلا يمضي شيءٌ فوق الحدّ بلا أثر. يراها مدير الفرع والإدارة.
create table if not exists approval_waivers (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  kind        text not null,
  amount      numeric(14,2) not null default 0,
  threshold   numeric(14,2),
  reason      text not null check (reason in ('delegation', 'routing_none')),
  note        text,
  actor_id    uuid references users(id),
  actor_name  text,
  actor_role  text,
  created_at  timestamptz not null default now()
);
create index if not exists approval_waivers_branch_at on approval_waivers(branch_id, created_at desc);
alter table approval_waivers enable row level security;
drop policy if exists branch_isolation_approval_waivers on approval_waivers;
create policy branch_isolation_approval_waivers on approval_waivers
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
