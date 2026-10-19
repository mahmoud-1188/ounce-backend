-- حسابات الخسائر وفروق العملة — أوراقٌ تقبل قيد التسوية اليدوي وحده (لا قاعدة ترحيلٍ لها).
insert into accounts (code, name, parent_code, unit, nature, statement, is_group) values
  ('1380', 'تأمينات لدى الغير', '1300', 'currency', 'debit', 'balance', false),
  ('1385', 'ضرائب مخصومة من المنبع — مستردّة', '1300', 'currency', 'debit', 'balance', false),
  ('6820', 'خسائر فروق العملة', '6000', 'currency', 'debit', 'income', false),
  ('6830', 'خسائر أخرى', '6000', 'currency', 'debit', 'income', false)
on conflict (code) do nothing;
-- أرباح فروق العملة تحت «إيرادات أخرى» (4300) إن وُجدت، وإلا تحت الإيرادات (4000)
insert into accounts (code, name, parent_code, unit, nature, statement, is_group)
select '4370', 'أرباح فروق العملة', case when exists (select 1 from accounts where code = '4300') then '4300' else '4000' end, 'currency', 'credit', 'income', false
on conflict (code) do nothing;
