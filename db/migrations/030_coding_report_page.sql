-- 030_coding_report_page.sql
--
-- إتاحة صفحة "تقرير التكويد" (codingReport) الجديدة في allowed_more
-- للمدير — نفس نمط 017_hq_reports.sql/027_hq_transactions.sql بالضبط.
-- الصفحة نفسها تجميع محلي بحت فوق items/lots/suppliers المحمَّلة أصلًا
-- من bootstrap (لا جدول جديد ولا مسار خلفي جديد — نظير buildCodingReport.js
-- في المرجع، لكن بأسماء حقول الباك إند الحقيقية: categoryId لا category،
-- workmanship (الإجمالي المُخزَّن فعليًا لكل صنف) لا workmanshipPerUnit
-- المُعاد حسابه، dateAdded/createdBy القادمان من bootstrap.routes.js).
update roles set allowed_more = allowed_more || '["codingReport"]'::jsonb
  where id = 'manager' and not (allowed_more @> '["codingReport"]'::jsonb);
