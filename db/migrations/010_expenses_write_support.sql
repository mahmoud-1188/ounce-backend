-- 010_expenses_write_support.sql
--
-- الفجوة: /day/close (migration 008) يقرأ فعليًا sum(amount) from expenses
-- لحساب إجمالي المصروفات عند إقفال اليوم — لكن جدول expenses (موجود أصلًا
-- في schema.sql القسم 14) لم يكن له أي route كتابة إطلاقًا؛ المصروفات
-- كانت تُحفظ محليًا فقط (localStorage) فلا تصل أبدًا لهذا الجدول، ما يعني
-- أن رقم إغلاق اليوم "expenses_sum" كان دائمًا صفرًا زائفًا بصمت.
--
-- الأعمدة الموجودة أصلًا (id, branch_id, ref, name_id, amount,
-- business_day_id, created_by, created_at) تكفي فقط لأبسط شكل مصروف.
-- شكل السجل الفعلي في الواجهة (handleAddExpense) يحمل أيضًا: تصنيف ثابت
-- (EXPENSE_CATEGORIES)، مصدر التمويل (خزنة/صندوق × نقدي/شبكة)، تكرار
-- شهري، موظف مرتبط (رواتب/سلف)، شهر الفترة، وملاحظة — هذا الملف يضيفها.

alter table expenses
  add column if not exists name text,
  add column if not exists category text,
  add column if not exists note text,
  add column if not exists recurring boolean not null default false,
  add column if not exists funding_source text,
  add column if not exists employee_id uuid references users(id),
  add column if not exists period_month text;

-- ⚠ أسماء المصروفات المحفوظة (expense_names) تحمل تصنيفًا في الواجهة
-- (لعرض المسميات الخاصة بالتصنيف الحالي أولًا) لا عمود له في الجدول
-- الأصلي — يُضاف هنا لنفس السبب.
alter table expense_names
  add column if not exists category text;

alter table expenses enable row level security;
create policy branch_isolation_expenses on expenses
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table expense_names enable row level security;
create policy branch_isolation_expense_names on expense_names
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

create index if not exists idx_expenses_business_day on expenses(business_day_id);
