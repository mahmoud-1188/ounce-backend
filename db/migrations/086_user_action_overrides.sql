-- استثناءات الأفعال لكل شخص فوق دوره: action_grant يفتح فعلًا يمنعه الدور،
-- وaction_revoke يغلق فعلًا يسمح به. منع الإدارة المركزية يغلب الاستثناء دائمًا.
alter table users add column if not exists action_grant text[] not null default '{}';
alter table users add column if not exists action_revoke text[] not null default '{}';

-- سجلّ الصلاحيات يقبل استثناء الأفعال، وإلغاء الجهاز الذي كان يُرفض بالقيد فيفشل الإلغاء نفسه
alter table permission_log drop constraint if exists permission_log_kind_check;
alter table permission_log add constraint permission_log_kind_check
  check (kind in ('create','delete','role','pages','reset','ai','rename','enroll','pin','activate','actions','device_revoke'));

-- رمز القطعة المحجوزة بعينها (يُمسح عند الحجز) — يظهر على الحجز وعند التسليم
alter table reservations add column if not exists unit_codes text[] not null default '{}';

-- تسوية إقرار ضريبة القيمة المضافة: قيدٌ يُقفل 2220 للفترة ويسدّد من الخزنة، ويُلغى بقيدٍ عكسي وسببٍ مكتوب
create table if not exists vat_settlements (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  period_from date not null,
  period_to date not null,
  output_vat numeric(14,2) not null default 0,
  input_vat numeric(14,2) not null default 0,
  paid numeric(14,2) not null default 0,
  source text,
  entry_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references users(id),
  reverse_reason text
);
create index if not exists vat_settlements_branch_idx on vat_settlements (branch_id, period_from);
alter table vat_settlements enable row level security;
drop policy if exists branch_isolation_vat_settlements on vat_settlements;
create policy branch_isolation_vat_settlements on vat_settlements
  using (branch_id = (current_setting('app.current_branch_id', true))::uuid);

insert into posting_rules (op_type, label, rule) values
  ('vat_settlement', 'تسوية إقرار ضريبة القيمة المضافة وسدادها', '{"cash": {"debit": "2220", "credit": "1110"}}'),
  ('vat_settlement_reversal', 'إلغاء تسوية إقرار الضريبة', '{"cash": {"debit": "1110", "credit": "2220"}}')
on conflict (op_type) do nothing;

-- فاتورة المصروف أو إيصاله: معرّف المرفق المحفوظ على الجهاز الذي سجّله
alter table expenses add column if not exists attach_id text;
