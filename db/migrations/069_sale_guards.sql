-- رقابة البيع المشتركة وصحّة الدفاتر (المرجع: ت١ «صحة الدفاتر» — 2026-09-30).
--
-- ① نوعا اعتمادٍ جديدان على كل مسارات البيع (الفاتورة · البيع بالوزن · جزء الطقم):
--    «أرضية السعر» — بيعٌ تحت تكلفة القطعة أو تحت قيمة ذهبها الصافي بسعر اليوم،
--    و«حدّ الآجل» — آجلٌ يتجاوز حدّ العميل أو لعميلٍ عليه فاتورةٌ آجلة متأخّرة.
--    الحدّ صفر: كل حالةٍ منهما تحتاج اعتمادًا (المدير يعتمد نفسه ويُسجَّل).
-- ② حدّ الآجل لكل عميل، وافتراضيٌّ وأيام التأخّر في إعدادات الفرع (صفر = بلا فحص).
-- ③ العربون المحتجز عند إلغاء الحجز بلا ردّ يُصادَر إيرادًا (4350) — كان يبقى التزامًا في 2210 إلى الأبد.

insert into approval_rules (id, label, threshold, approver_role) values
  ('price_floor', 'بيعٌ تحت أرضية السعر', 0, 'manager'),
  ('credit_limit', 'آجلٌ فوق حدّ العميل', 0, 'manager')
on conflict (id) do nothing;

alter table customers add column if not exists credit_limit numeric(14,2);
alter table branch_settings add column if not exists credit_limit_default numeric(14,2) not null default 0;
alter table branch_settings add column if not exists credit_overdue_days int not null default 0;

insert into accounts (code, name, parent_code, unit, nature, statement, is_group) values
  ('4350', 'عرابين مصادَرة', '4300', 'currency', 'credit', 'income', false)
on conflict (code) do nothing;

insert into posting_rules (op_type, label, rule) values
  ('deposit_forfeit', 'مصادرة عربون حجزٍ ملغى',
   '{"label": "مصادرة عربون حجزٍ ملغى", "cash": {"debit": "2210", "credit": "4350"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

alter table reservations add column if not exists forfeited numeric(14,2) not null default 0;
