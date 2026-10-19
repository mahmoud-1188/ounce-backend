-- التفويض بضغطة من الإدارة لكل فرع: { full: «تفويض كامل للفرع», noApprovals: «بلا موافقات» }.
-- full: الفرع يقرّر كل اعتماداته بنفسه (لا شيء يصعد للإدارة) ويدير صلاحيات موظفيه.
-- noApprovals: لا طلبات اعتماد أصلًا — كل عمليةٍ تُنفَّذ مباشرة.
-- بلا تفويض: حدود الاعتماد وصلاحيات الموظفين للإدارة وحدها.
alter table branches add column if not exists delegation jsonb not null default '{}'::jsonb;
