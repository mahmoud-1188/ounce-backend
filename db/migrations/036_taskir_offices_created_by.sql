-- 036_taskir_offices_created_by.sql
--
-- POST /taskirat/offices يكتب created_by، والعمود غير موجود في
-- taskir_offices — فكان إنشاء مكتب تسكير يفشل بخطأ خادم دائمًا.
-- آمنة للتشغيل أكثر من مرة.

alter table taskir_offices add column if not exists created_by uuid references users(id);
