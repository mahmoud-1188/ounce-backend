-- أجهزة الدخول المربوطة: الحساب لا يدخل إلا من جهازٍ رُبط برمز (سياسة لكل فرع تضبطها الإدارة)
--   جهازٌ شخصي: مربوطٌ بموظفٍ واحد، والدخول منه بالرقم السري وحده.
--   جهاز الفرع (تابلت مشترك): مربوطٌ بالفرع، وأي موظفٍ فيه يدخل باسمه ورقمه.
create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  user_id uuid references users(id),          -- null = جهاز الفرع المشترك
  label text,
  token_hash text not null unique,
  user_agent text,
  created_by text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by text
);
create index if not exists idx_devices_branch on devices(branch_id, user_id);
alter table devices enable row level security;
drop policy if exists branch_isolation_devices on devices;
create policy branch_isolation_devices on devices using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- رمز ربط جهاز الفرع لا يخصّ موظفًا
alter table enroll_invites alter column user_id drop not null;
alter table enroll_invites add column if not exists kind text not null default 'user' check (kind in ('user', 'shared'));

-- السياسة: off (بلا قيد) · managers (المدير ونائبه والمحاسب) · all (كل الموظفين)
alter table branch_settings add column if not exists device_lock text not null default 'off'
  check (device_lock in ('off', 'managers', 'all'));
