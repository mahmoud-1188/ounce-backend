-- 034_workday_mode.sql
--
-- يوم العمل اختياري (workdayMode في المرجع): محلٌّ لا يريد فتح يومٍ
-- وإقفاله كل صباحٍ ومساء يطفئه من الإعدادات، فتُسجَّل الحركات بلا يوم.
--
--   • branch_settings.workday_mode — 'required' (الافتراضي، السلوك الحالي)
--     أو 'off'.
--   • sales.business_day_id يقبل null — الجدول الوحيد الذي كان يفرضه؛ بقية
--     الجداول تقبله فارغًا أصلًا.
--
-- يومٌ حقيقي مفتوح يبقى مقدَّمًا حتى يُقفل، ولو كان الوضع مطفأ.
-- آمنة للتشغيل أكثر من مرة.

alter table branch_settings add column if not exists workday_mode text not null default 'required';
alter table branch_settings drop constraint if exists branch_settings_workday_mode_check;
alter table branch_settings add constraint branch_settings_workday_mode_check
  check (workday_mode in ('required','off'));

alter table sales alter column business_day_id drop not null;
