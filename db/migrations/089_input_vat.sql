-- ضريبة المدخلات (المشتريات والمصروفات): حساب 1360 أصلٌ يُطرح من ضريبة المبيعات في الإقرار
insert into accounts (code, name, parent_code, unit, nature, statement, is_group)
values ('1360', 'ضريبة القيمة المضافة — المدخلات', '1300', 'currency', 'debit', 'balance', false)
on conflict (code) do nothing;

alter table expenses add column if not exists vat_amount numeric(14,2) not null default 0;
alter table purchases add column if not exists input_vat numeric(14,2) not null default 0;

insert into posting_rules (op_type, label, rule) values
  ('purchase_input_vat', 'ضريبة مدخلات فاتورة المورد', '{"cash": {"debit": "1360", "credit": "1110"}, "label": "ضريبة مدخلات فاتورة المورد", "weight": null}')
on conflict (op_type) do nothing;
