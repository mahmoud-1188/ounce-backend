-- ذهب مشغول بالخزنة غير مُكوَّد (المرجع 2026-10-12 هـ): حسابٌ وزنيّ مستقلّ 1215 بقاعدتَي safe_crafted_in/out.
-- كان المشغول في الخزنة يُرحَّل على 1210 (المخزون المكوَّد الجاهز للبيع) فيختلط بقطعٍ لها رموز،
-- ويختلف رصيد 1210 بالجرام عمّا على الرفّ. الآن: الكسر 1220 · المشغول غير المكوَّد 1215 · المكوَّد 1210.
insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method) values
  ('1215', 'ذهب مشغول بالخزنة — غير مُكوَّد', '1200', 'both', 'debit', 'balance', false, NULL, NULL)
on conflict (code) do nothing;

insert into weight_accounts (account_code) values ('1215')
on conflict do nothing;

insert into posting_rules (op_type, label, rule) values
  ('safe_crafted_in', 'إدخال ذهب مشغول للخزنة',
   '{"label": "إدخال ذهب مشغول للخزنة", "cash": null, "weight": {"from": null, "to": "1215"}}'::jsonb),
  ('safe_crafted_out', 'سحب ذهب مشغول من الخزنة',
   '{"label": "سحب ذهب مشغول من الخزنة", "cash": null, "weight": {"from": "1215", "to": null}, "requires": "destination"}'::jsonb)
on conflict (op_type) do nothing;

-- ما سُجّل سابقًا من مشغول الخزنة على 1210 يُنقل إلى 1215 بنوع حركته، فيبدأ رصيد 1215 صحيحًا
-- ولا يُسحب منه بعد اليوم ما أُودع قبله. وزنٌ بلا مال: لا قيد ماليّ يتغيّر.
update gold_ledger_entries g
   set to_account = '1215', op_type = 'safe_crafted_in'
  from safe_gold_tx t
 where g.ref_table = 'safe_gold_tx' and g.ref_id = t.id and t.kind = 'crafted'
   and g.op_type = 'safe_gold_in' and g.to_account = '1210';

update gold_ledger_entries g
   set from_account = '1215', op_type = 'safe_crafted_out'
  from safe_gold_tx t
 where g.ref_table = 'safe_gold_tx' and g.ref_id = t.id and t.kind = 'crafted'
   and g.op_type = 'safe_gold_out' and g.from_account = '1210';
