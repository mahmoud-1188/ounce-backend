-- خصائص الأحجار والساعات (المرجع 5.2.0: وحدتا gemstones وwatches):
--   { "gem": { carat, clarity, color, cut, lab, certNo }, "watch": { brand, model, serial, warrantyMonths } }
alter table items add column if not exists attrs jsonb;
