-- 031_query_builder_page.sql
--
-- إتاحة صفحة "مُنشئ الاستعلام" (queryBuilder) الجديدة في allowed_more
-- للمدير — نفس نمط 030_coding_report_page.sql بالضبط. الصفحة قراءةٌ
-- محلية بحتة فوق journal/goldLedger المحمَّلين أصلًا من bootstrap (لا
-- جدول جديد ولا مسار خلفي جديد لهذه الميزة نفسها). راجع core/chart.js
-- (ثابت JOURNALS) وdomain/helpers.js (runQuery/describeQuery) للتفصيل
-- الكامل — تصنيفٌ حقيقي لكل الـ76 نوع عملية الفعلي في POSTING_RULES
-- إلى ستة دفاتر يومية، لا الستة الأصغر في المرجع.
update roles set allowed_more = allowed_more || '["queryBuilder"]'::jsonb
  where id = 'manager' and not (allowed_more @> '["queryBuilder"]'::jsonb);
