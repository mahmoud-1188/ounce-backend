-- العملاء على الخادم مع هويتهم (المرجع 5.2.0: وحدة aml — مكافحة غسل الأموال):
--   هوية العميل إلزامية لدفعٍ نقدي يبلغ الحدّ، وتُحفظ على الفاتورة للسجلّ.
alter table customers add column if not exists id_number text;
alter table customers add column if not exists note text;
alter table sales add column if not exists kyc jsonb;
