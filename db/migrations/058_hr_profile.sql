-- ملفّ الموظف الكامل (المرجع 5.2.0: HR_PROFILE_FIELDS · HR_DOCS): الهوية والإقامة والجواز والعقد والبنك،
-- وتنبيهات انتهاء المستندات، وملف حماية الأجور (WPS) من مسيّر الشهر بالآيبان.
alter table users add column if not exists hr_profile jsonb not null default '{}'::jsonb;
