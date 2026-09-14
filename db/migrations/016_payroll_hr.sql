-- 016_payroll_hr.sql
--
-- يفعّل الرواتب/الموارد البشرية بالكامل: جداول gosi_rates/payroll_runs/
-- payroll_lines/attendance/leave_requests/commissions موجودة في schema.sql
-- منذ البداية (قسم "11. Payroll / HR") ومصروفة جزئيًا في seed.sql
-- (gosi_rates + posting_rules.payroll_run/payroll_pay/gosi_pay/eos_pay)
-- — تمامًا كحال الأصول الثابتة قبل migration 015 — لكن بلا أي عمود بيانات
-- HR على users، وبلا endpoint واحد يلمس أيًّا من هذه الجداول.
--
-- ⚠ فجوة حقيقية حتى في المرجع نفسه (لا في تطبيقنا فقط): PayrollPage.js/
-- computePayslip.js يقرآن attendance/leaves كمصفوفتين محليتين، لكن لا
-- شاشة واحدة في المرجع تكتب فيهما — setAttendance/setLeaves بلا أي
-- استدعاء كتابة حقيقي، فتبقيان فارغتين دومًا عمليًا (absentDays/
-- unpaidLeaveDays = صفر دائمًا). بما أن الطلب هنا "النطاق الكامل"، نبني
-- شاشتي حضور/إجازات حقيقيتين فوق الجدولين الموجودين أصلًا في schema.sql
-- بدل ترك نفس الفجوة الميتة في تطبيقنا.

-- ── 1) بيانات HR على users ──
--
-- المرجع (HrFieldsForm.js) يخزّن هذه على كائن الموظف نفسه (users) لا في
-- جدول منفصل — نتبعه: راتب/بدلات/جنسية/تاريخ تعيين لكل مستخدم.
alter table users add column if not exists basic_salary numeric(14,2);
alter table users add column if not exists housing numeric(14,2);
alter table users add column if not exists transport numeric(14,2) default 0;
alter table users add column if not exists other_allowance numeric(14,2) default 0;
alter table users add column if not exists nationality text check (nationality in ('saudi', 'expat'));
alter table users add column if not exists hire_date date;
-- ⚠ مغادرة الموظف (نهاية الخدمة) تُسجَّل على نفس الصف — active=false
-- الموجود أصلًا يكفي "غير نشط"، لكن لا عمود يوضّح متى/لماذا/كم صُرف.
alter table users add column if not exists left_at timestamptz;
alter table users add column if not exists leave_reason text check (leave_reason in ('termination', 'resignation'));
alter table users add column if not exists eos_paid numeric(14,2);

-- ── 2) السلف: إعادة استخدام expenses (category='advance') لا جدول جديد ──
--
-- expenses.routes.js (migration 010) وwithBranch/employee_id موجودان
-- أصلًا للسلفة — الناقص فقط "استُرِدَّت في مسيّر رواتب أي شهر" كي لا
-- تُخصم مرتين. هذا يطابق حرفيًا تعليق openAdvances/settled في المرجع.
alter table expenses add column if not exists settled boolean not null default false;
alter table expenses add column if not exists settled_period text;

-- ── 3) عمولات البائعين: commissions موجود أصلًا وفارغ تمامًا ──
--
-- كانت قاعدة العمولة (basis/rate/target/perInvoice) محلية بحتة في
-- تطبيقنا (COMMISSIONS_KEY) رغم وجود جدول حقيقي جاهز لها — قاعدة عمولة
-- بائع بيانات عمل حقيقية يجب أن تظهر لكل مستخدم بعد أي تحديث، لا مثل
-- إعدادات جهاز محلية (طابعة/قارئ). صف واحد لكل بائع؛ upsert يستبدله.
alter table commissions add constraint commissions_user_uq unique (user_id);

-- ── 4) payroll_runs/payroll_lines: أعمدة تجميد الكشف الناقصة ──
--
-- المرجع يجمّد على "run" كائنًا كاملًا (ref, netPayable, employerCost,
-- gosiDue, paid{}, gosiPaidAt) — جدولنا الحالي (schema.sql) عنده period/
-- status/created_by فقط. period فريد لكل فرع (لا يُحتسب شهر مرتين).
alter table payroll_runs add column if not exists ref text;
alter table payroll_runs add column if not exists gosi_due numeric(14,2) default 0;
alter table payroll_runs add column if not exists gosi_paid_at timestamptz;
alter table payroll_runs add column if not exists gosi_paid_source text check (gosi_paid_source in ('safe_cash', 'safe_network'));
alter table payroll_runs add column if not exists journal_entry_id uuid references journal_entries(id);
create unique index if not exists payroll_runs_branch_period_uq on payroll_runs (branch_id, period);

-- payroll_lines: تجميد كل مكوّنات القسيمة وقت الاحتساب (لا إعادة حسابها
-- من بيانات متغيّرة لاحقًا — موظف غادر أو تغيّر راتبه بعد الاحتساب يجب
-- ألا يغيّر كشفًا مُحتسَبًا سلفًا)، بالإضافة لحالة الصرف الفردي.
alter table payroll_lines add column if not exists other_allowance numeric(14,2) default 0;
alter table payroll_lines add column if not exists advances numeric(14,2) default 0;
alter table payroll_lines add column if not exists absent_days smallint default 0;
alter table payroll_lines add column if not exists unpaid_leave_days smallint default 0;
alter table payroll_lines add column if not exists absence_deduction numeric(14,2) default 0;
alter table payroll_lines add column if not exists eos_accrual numeric(14,2) default 0;
alter table payroll_lines add column if not exists employer_cost numeric(14,2) default 0;
alter table payroll_lines add column if not exists paid_at timestamptz;
alter table payroll_lines add column if not exists paid_source text check (paid_source in ('safe_cash', 'safe_network'));

-- ── 5) الحضور/الإجازات: حقول القرار الناقصة لاحتساب الغياب ──
--
-- attendance الحالي (check_in/check_out فقط) لا يميّز "حضر متأخرًا" عن
-- "غائب" — نضيف status صريحة (المرجع نفسه لا يحدّد شكلها، فنختار أبسط
-- ما يخدم computePayslip: absent/excused). leave_requests عنده status
-- أصلًا (pending/approved/rejected) — يكفي بلا تعديل لحساب الإجازة غير
-- المدفوعة المعتمدة لشهر بعينه (start_date/end_date موجودان فعلًا).
alter table attendance add column if not exists status text not null default 'present'
  check (status in ('present', 'absent', 'late'));
alter table attendance add column if not exists excused boolean not null default false;
alter table attendance add column if not exists note text;
create unique index if not exists attendance_user_date_uq on attendance (user_id, date);

-- ── 6) شاشتا "الرواتب" و"الحضور/الإجازات" جديدتان في allowed_more ──
--
-- بنفس نمط fixedAssets تمامًا: صفحتان يحكمهما الفرونت إند فقط (بلا
-- requirePage خاص بهما)، وكل endpoint فعلي محميّ في الباك إند مباشرة.
update roles
   set allowed_more = allowed_more || '["payroll","attendanceHr"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["payroll"]'::jsonb);
