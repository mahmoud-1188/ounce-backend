-- 040: سياسة الإدارة على الشاشات والعمليات (تبويبا «الشاشات» و«العمليات» في المرجع)
--
-- shape: { byRole:   { <role|*>: { deny:[pageId], grant:[pageId], denyActions:[actionId] } },
--          byBranch: { <branchId>: { <role|*>: {...} } } }
-- الشاشات: قيد الفرع للدور يحلّ محلّ قيد الدور العام. والمنع يغلب المنح.
-- العمليات: المنع يجتمع من كل النطاقات (الفرع/الدور/الكل) — يُضيّق فقط.
alter table stores add column if not exists hq_policy jsonb not null default '{}'::jsonb;
alter table stores add column if not exists hq_policy_at timestamptz;
alter table stores add column if not exists hq_policy_by text;
