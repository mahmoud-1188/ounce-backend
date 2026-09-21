-- 025_branches_soft_delete.sql
--
-- ⚠ حذف فرع لم يكن ممكنًا إطلاقًا قبل هذه الهجرة (لا مسار API ولا زر في
-- الواجهة) — فرعٌ تجريبي يُنشأ بالخطأ كان يبقى للأبد ويُحتسَب دائمًا ضمن
-- stores.max_branches. هذا تعطيل منطقي (soft-delete) لا حذف فعلي: فرعٌ
-- قد يحمل مبيعات/مخزون/محاسبة حقيقية، وأي DELETE فعلي من branches كان
-- سيفشل أصلًا (foreign keys من عشرات الجداول تشير إليه) أو، أسوأ، كان
-- سيحتاج CASCADE يمحو تاريخًا ماليًا لا يمكن استرجاعه. نفس نمط
-- users.active الموجود بالفعل لموظفي الفرع.
alter table branches add column deleted_at timestamptz;

-- ⚠ فهرس جزئي (partial index): كل استعلامات "الفروع الحيّة" (قائمة
-- المركزي، التقرير المجمّع، سقف الاشتراك، تسجيل الدخول...) ستُضيف الآن
-- where deleted_at is null — هذا الفهرس يخدمها كلها دون فحص الصفوف
-- المحذوفة أصلًا.
create index if not exists idx_branches_active on branches(store_id) where deleted_at is null;
