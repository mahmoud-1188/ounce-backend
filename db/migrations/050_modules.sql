-- الوحدات الاختيارية (المرجع 5.2.0: MODULES): تُفعَّل لكل فرعٍ من «الوحدات»، ولكلٍّ إعداداتها.
--   { "discountLimit": { "on": true, "cfg": { "maxPct": { "employee": 3 } } }, ... }
alter table branch_settings add column if not exists modules jsonb not null default '{}'::jsonb;
