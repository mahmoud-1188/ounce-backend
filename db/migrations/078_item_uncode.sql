-- إلغاء تكويد قطعة: يعيد وزنها لدفعتها المفتوحة (أو يحذفها من الافتتاحي في فترة التجهيز) ويُلغي رمزها — يعتمده المدير
insert into approval_rules (id, label, threshold, approver_role) values
  ('item_uncode', 'إلغاء تكويد قطعة', 0, 'manager')
on conflict (id) do nothing;
