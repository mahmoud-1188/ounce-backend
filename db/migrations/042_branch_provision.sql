-- 042: تجهيز الفرع من الإدارة (HqBranchProvisionForm في المرجع)
--
-- profile: هوية الفرع على مستنداته (اسم المحل، الاسم القانوني، السجل، الرقم
--          الضريبي، التواصل، الشعار).
-- provision: إعداداتٌ تعيش في الواجهة (هوامش العيارات، من يفحص الكسر) تُطبَّق
--          في الفرع عند الدخول.
-- الإعدادات الخادمية (الضريبة، يوم العمل، الاعتمادات) تُكتب مباشرةً في
-- branch_settings. وsettings_locked يمنع مدير الفرع من تغييرها محليًّا.
alter table branches add column if not exists profile jsonb not null default '{}'::jsonb;
alter table branches add column if not exists provision jsonb not null default '{}'::jsonb;
alter table branches add column if not exists settings_locked boolean not null default false;
alter table branches add column if not exists provisioned_at timestamptz;
alter table branches add column if not exists provisioned_by text;
