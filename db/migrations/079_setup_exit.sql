-- بيعٌ بلا سعر في فترة التجهيز: رقم الإخراج (SX-) وملاحظته على القطعة الخارجة قبل التشغيل
alter table item_units add column if not exists exit_ref text;
alter table item_units add column if not exists exit_note text;
create index if not exists idx_item_units_exit on item_units (exit_ref) where exit_ref is not null;
