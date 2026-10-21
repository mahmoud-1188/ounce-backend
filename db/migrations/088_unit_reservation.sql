-- الحجز يقفل القطعة الممسوحة وحدها (لا الصنف كله): باقي قطع الصنف تُباع لغيره.
-- حجزٌ بلا قطعةٍ بعينها يبقى على الصنف (items.reserved_for) كما كان.
alter table item_units add column if not exists reserved_for uuid references reservations(id);
create index if not exists item_units_reserved_for_idx on item_units (reserved_for) where reserved_for is not null;
