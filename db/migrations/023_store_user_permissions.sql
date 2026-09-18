-- 023_store_user_permissions.sql
--
-- صلاحيات مستخدم مركزي مبسّطة: لا نظام أدوار متعدّدة/فصل مهام (SoD)
-- كامل كالمرجع (HqOrgChart.js) — قرارٌ صريح (راجع محادثة إضافة هذه
-- الهجرة): متجرٌ بحجم فريق مركزي صغير (owner + بضعة موظفين) لا يحتاج
-- تعقيد أدوارٍ متخصصة (cfo, auditor...)، ويكفيه أن يختار owner لكل
-- موظف مركزي أي شاشات من الأربع الحالية (الرئيسية/الفروع/التقرير/
-- التحليلات) يراها، وهل يملك صلاحية إنشاء فروع جديدة أم لا.
--
-- ⚠ allowed_pages = null (لا مصفوفة فارغة) يعني "owner بلا قيد" — نفس
-- اتفاقية allowed_pages في جدول users (مستخدم الفرع) تمامًا: NULL يعني
-- "استخدم افتراضي دوره"، لا "لا شيء مسموح".
alter table store_users
  add column allowed_pages jsonb,
  add column can_manage_branches boolean not null default false;

-- ⚠ owner الحاليون (الوحيدون الموجودون فعليًّا في القاعدة حتى الآن)
-- يحتفظون بكل الصلاحيات صراحةً — لا يُفاجَأ أحد بفقدان وصولٍ كان يملكه
-- فور تشغيل هذه الهجرة.
update store_users set can_manage_branches = true where role = 'owner';
