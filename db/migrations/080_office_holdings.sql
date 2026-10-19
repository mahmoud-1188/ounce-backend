-- مكتب التسكير كالبنك: ذهبٌ لنا محفوظٌ عند المكتب (1240) بوزنه وتكلفته — سطور taskir_office_tx بنوع hold
alter table taskir_office_tx drop constraint if exists taskir_office_tx_kind_check;
alter table taskir_office_tx add constraint taskir_office_tx_kind_check check (kind = any (array['gold', 'cash', 'hold']));

-- قواعد الترحيل لعمليات المحفوظ عند المكتب
insert into posting_rules (op_type, label, rule) values
  ('office_hold_buy', 'شراء ذهب وإيداعه عند مكتب التسكير', '{"cash": {"debit": "1240", "credit": "1110"}, "weight": {"from": null, "to": "1240"}}'),
  ('office_hold_buy_deferred', 'شراء ذهب آجلًا وإيداعه عند المكتب', '{"cash": {"debit": "1240", "credit": "2130"}, "weight": {"from": null, "to": "1240"}}'),
  ('office_hold_withdraw', 'سحب ذهبنا من المكتب إلى الخزنة', '{"cash": {"debit": "1220", "credit": "1240"}, "weight": {"from": "1240", "to": "1220"}}'),
  ('office_hold_to_supplier', 'سداد مورد من ذهبنا عند المكتب', '{"cash": {"debit": "2110", "credit": "1240"}, "weight": {"from": "1240", "to": null}}')
on conflict (op_type) do nothing;
