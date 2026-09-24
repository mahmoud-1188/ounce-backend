-- 039_hq_console.sql
--
-- لوحة الإدارة (v197 في المرجع — HqConsolePage):
--
--   ① من يعتمد ماذا — لكل متجر: كل نوع اعتماد (مصروف · ردّ مبلغ · سداد مورد)
--      إمّا بيد مدير الفرع أو تعتمده الإدارة. ما للإدارة لا يعتمده الفرع
--      ولو كان مديرًا — يبقى معلّقًا حتى تقرّر الإدارة، ثم يُنفّذه الفرع.
--   ② أهداف المبيعات لكل فرع (30 يومًا) — الإنجاز من مبيعاته الفعلية.
--   ③ أحكام المراجعة والتسويات من الإدارة: المُراجِع قد لا يكون مستخدم فرع.
--
-- آمنة للتشغيل أكثر من مرة.

alter table stores add column if not exists approval_routing jsonb not null default '{}'::jsonb;

alter table branches add column if not exists target30 numeric(14,2) not null default 0;

-- مُراجعٌ من الإدارة: اسمه ونوعه بلا مستخدم فرع
alter table reviews add column if not exists reviewer_kind text not null default 'branch';
alter table approvals add column if not exists decided_by_hq text;

-- قيد التسوية اليدوي صار يُرحَّل من الإدارة أيضًا — تسميةٌ عامة
update posting_rules set label = 'قيد تسوية',
  rule = '{"label": "قيد تسوية", "cash": null, "weight": null}'::jsonb
 where op_type = 'manual_adjustment';
