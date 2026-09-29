-- الزكاة بطريقةٍ واحدة ومفتاحٍ في الإعدادات (المرجع 5.2.0 — قرار المالك 2026-09-29).
-- مفعّلةٌ افتراضًا فلا يفقد محلٌّ قائم رقمه بصمت؛ والسنة ميلادية افتراضًا (سنة الدفتر المالية).
alter table branch_settings add column if not exists zakat_enabled boolean not null default true;
alter table branch_settings add column if not exists zakat_year text not null default 'gregorian';
alter table branch_settings drop constraint if exists branch_settings_zakat_year_check;
alter table branch_settings add constraint branch_settings_zakat_year_check check (zakat_year in ('gregorian', 'hijri'));
