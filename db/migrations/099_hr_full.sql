-- الموارد البشرية كما في المرجع (HrPage): سياسة الموارد · الإضافي والمكافآت والجزاءات في مسيّر الشهر · أوقات الحضور والانصراف.
--   • branch_settings.hr_policy: الوردية وسماح التأخير والإجازة الأسبوعية وتنبيه الوثائق وحدود القروض.
--   • payroll_adjustments: بندٌ لموظفٍ في شهر — إضافي (بالساعات، أجر الساعة + 50٪ من الأساسي — نظام العمل م107)
--     أو مكافأة أو جزاء (لا يتجاوز أجر خمسة أيام في الشهر — م67). يدخل مسيّر شهره، ولا يُلغى بعده.
--   • attendance.check_in/check_out موجودان؛ late_min وovertime_min يُحسبان من السياسة عند التسجيل.
alter table branch_settings add column if not exists hr_policy jsonb not null default '{}'::jsonb;

create table if not exists payroll_adjustments (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  user_id     uuid not null references users(id),
  period      text not null check (period ~ '^\d{4}-\d{2}$'),
  kind        text not null check (kind in ('overtime', 'bonus', 'penalty')),
  hours       numeric(8,2) not null default 0,
  amount      numeric(14,2) not null check (amount >= 0),
  reason      text,
  created_by  uuid references users(id),
  created_at  timestamptz default now(),
  cancelled_at timestamptz
);
create index if not exists payroll_adjustments_branch_period on payroll_adjustments(branch_id, period);
alter table payroll_adjustments enable row level security;
drop policy if exists branch_isolation_payroll_adjustments on payroll_adjustments;
create policy branch_isolation_payroll_adjustments on payroll_adjustments
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table payroll_lines add column if not exists overtime numeric(14,2) not null default 0;
alter table payroll_lines add column if not exists bonus numeric(14,2) not null default 0;
alter table payroll_lines add column if not exists penalty numeric(14,2) not null default 0;

alter table attendance add column if not exists late_min int not null default 0;
alter table attendance add column if not exists overtime_min int not null default 0;
