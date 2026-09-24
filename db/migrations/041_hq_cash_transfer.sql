-- 041: تحويل نقد من الإدارة إلى خزنة فرع (المرجع: handleHqCashTransfer / branch_cash_out|in)
--
-- الإدارة تحوّل من خزنة فرعٍ مصدر (الفرع الرئيسي افتراضًا) إلى فرعٍ آخر:
--   عند الإرسال (المصدر): مدين 1160 نقدٌ في الطريق / دائن 1110 الخزنة — نقدي
--   عند الاستلام (الوجهة): مدين 1110 الخزنة — نقدي / دائن 1160 نقدٌ في الطريق
-- فيتصفّر 1160 في الميزان الموحّد متى استُلم التحويل، ويبقى رصيده ما دام في الطريق.
insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method) values
  ('1160', 'نقدٌ في الطريق بين الفروع', '1100', 'currency', 'debit', 'balance', false, NULL, NULL)
on conflict (code) do nothing;

insert into posting_rules (op_type, label, rule) values
  ('branch_cash_out', 'تحويل نقد إلى فرع',
   '{"label": "تحويل نقد إلى فرع", "cash": {"debit": "1160", "credit": "1110"}, "weight": null}'::jsonb),
  ('branch_cash_in', 'استلام نقد من الإدارة',
   '{"label": "استلام نقد من الإدارة", "cash": {"debit": "1110", "credit": "1160"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

alter table hq_transactions drop constraint if exists hq_transactions_flow_check;
alter table hq_transactions add constraint hq_transactions_flow_check check (flow in (
  'purchase_request', 'goods_to_hq', 'goods_from_hq',
  'send_for_coding', 'taskir_to_hq', 'cash_transfer', 'cash_from_hq'
));
-- الفرع الذي خرج منه النقد (cash_from_hq)
alter table hq_transactions add column if not exists from_branch_id uuid references branches(id);
