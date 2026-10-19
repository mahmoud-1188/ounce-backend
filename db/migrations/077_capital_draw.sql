-- سحب الإدارة من رأس مال الفرع: الإدارة تطلب المبلغ، ومدير الفرع يوافق فيخرج النقد من خزنة الفرع إلى خزنة الإدارة
-- (أو يرفض بسببه). القيد على الطرفين عبر «تحويلات نقدية بين الفروع» (1170) كسائر النقد بين الفرع والإدارة.
alter table hq_transactions drop constraint if exists hq_transactions_flow_check;
alter table hq_transactions add constraint hq_transactions_flow_check check (flow in (
  'purchase_request', 'goods_to_hq', 'goods_from_hq',
  'send_for_coding', 'taskir_to_hq', 'cash_transfer', 'cash_from_hq', 'capital_draw'
));
