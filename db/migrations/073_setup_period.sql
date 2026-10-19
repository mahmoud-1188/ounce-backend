-- فترة التجهيز وبدء التشغيل باعتماد الإدارة.
-- setup: تكويد البضاعة القديمة والجرد والإعدادات وحدها — لا بيع ولا يوم ولا نقد ولا مصروف ولا قيد.
-- التسلسل: تكويد البضاعة (أو «لا بضاعة قديمة») ← الرصيد الافتتاحي محفوظًا ← «بدء التشغيل» (تعتمده الإدارة دائمًا في الفرع المرتبط).
-- الفروع القائمة تبقى live كما هي؛ الفرع الجديد يبدأ setup.
alter table branch_settings add column if not exists ledger_state text not null default 'live';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'branch_settings_ledger_state_check') then
    alter table branch_settings add constraint branch_settings_ledger_state_check check (ledger_state in ('setup', 'live'));
  end if;
end $$;
alter table branch_settings add column if not exists opening_balance jsonb;
alter table branch_settings add column if not exists opening_saved_at timestamptz;
alter table branch_settings add column if not exists no_old_stock boolean not null default false;
alter table branch_settings add column if not exists go_live_at timestamptz;
alter table branch_settings add column if not exists go_live_date date;
-- تكويد الافتتاح في التجهيز يُؤجَّل قيده إلى بدء التشغيل
alter table lots add column if not exists opening_posted boolean not null default true;
insert into approval_rules (id, label, threshold, approver_role) values
  ('go_live', 'بدء التشغيل', 0, 'manager')
on conflict (id) do nothing;
