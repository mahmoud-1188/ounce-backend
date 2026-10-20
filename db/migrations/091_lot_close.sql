-- إقفال دفعة المورد على الخادم: فرق المكوَّد عن المشترى عجزٌ (5330) أو زيادة (4320) بتكلفة الدفعة.
-- المخزون دوريّ (المشتريات في 5110)، فالقيد إعادة تبويبٍ من المشتريات لا يمسّ الربح — والوزن يخرج/يدخل 1210 فعلًا.
insert into posting_rules (op_type, label, rule) values
  ('coding_variance', 'فرق التكويد — عجز', '{"cash": {"debit": "5330", "credit": "5110"}, "weight": {"from": "1210", "to": null}}'),
  ('coding_surplus', 'فرق التكويد — زيادة', '{"cash": {"debit": "5110", "credit": "4320"}, "weight": {"from": null, "to": "1210"}}')
on conflict (op_type) do nothing;
alter table lots add column if not exists close_note text;
