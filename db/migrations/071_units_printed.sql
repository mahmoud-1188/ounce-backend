-- علامة «طُبع ملصقها» على القطعة صارت تُحفظ على الخادم (كانت في المتصفّح وحده).
-- القطع الموجودة قبل هذا تُعدّ مطبوعة — كي لا يتوقّف تحويلها؛ وما يُكوَّد بعده يبدأ «لم يُطبع» حتى يُطبع ملصقه.
update item_units set printed = true where printed is not true;
alter table item_units alter column printed set default false;
