-- شراء الإدارة على حساب فرع (المرجع 5.2.0: hq_purchase): الإدارة تشتري، والدفع من خزنة الفرع
-- (نقدًا أو شبكة)، والذهب يدخل مخزون الفرع دفعةً للتكويد. يوافق مدير الفرع قبل الخصم إن طُلب.
insert into approval_rules (id, label, threshold, approver_role) values
  ('hq_purchase', 'شراء من الإدارة على حساب الفرع', 0, 'manager')
on conflict (id) do nothing;
