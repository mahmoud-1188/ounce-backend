-- إقفال السنة المالية على الخادم (المرجع 5.2.0: FiscalYearPage).
-- كان الإقفال يُحفظ في متصفح جهازٍ واحد: لا قيد إقفالٍ في الأستاذ، ولا يراه جهازٌ آخر،
-- ويضيع بمسح بيانات المتصفح. الآن: قيد إقفالٍ ينقل أرصدة حسابات الدخل إلى 3300
-- الأرباح المحتجزة، وسجلٌّ دائم بلقطة الأرصدة الختامية (أساس السنة التالية في الواجهة).
alter table fiscal_closures add column if not exists ref text;
alter table fiscal_closures add column if not exists period_start timestamptz;
alter table fiscal_closures add column if not exists revenue numeric(14,2);
alter table fiscal_closures add column if not exists expenses numeric(14,2);
alter table fiscal_closures add column if not exists net_income numeric(14,2);
alter table fiscal_closures add column if not exists closing_entry_id uuid;
alter table fiscal_closures add column if not exists snapshot jsonb not null default '{}'::jsonb;
alter table fiscal_closures add column if not exists notes text;
alter table fiscal_closures enable row level security;
drop policy if exists branch_isolation_fiscal_closures on fiscal_closures;
create policy branch_isolation_fiscal_closures on fiscal_closures
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

insert into posting_rules (op_type, label, rule) values
  ('year_close', 'إقفال السنة المالية',
   '{"cash": null, "label": "إقفال السنة المالية", "weight": null, "note": "أرصدة حسابات الدخل (الإيرادات والمصروفات) تُقفل في 3300 الأرباح المحتجزة"}'::jsonb)
on conflict (op_type) do nothing;
