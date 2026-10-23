-- المحاسبة بسيطة أو مفصّلة في الإدارة (المرجع 2026-10-11): «بسيطة» تُخفي في تطبيق الإدارة الدفاتر
-- التفصيلية (الميزان الموحّد والسنة المالية) وتُبقي الفروع والتقارير والزكاة والصافي بالوزن والاعتمادات.
-- تخفي ولا تحذف: القيود تُرحَّل في الحالين. والفرع يأخذ وضعه من تجهيز الإدارة (local.accountingMode).
alter table stores add column if not exists accounting_mode text not null default 'detailed';
alter table stores drop constraint if exists stores_accounting_mode_check;
alter table stores add constraint stores_accounting_mode_check check (accounting_mode in ('detailed', 'simple'));
