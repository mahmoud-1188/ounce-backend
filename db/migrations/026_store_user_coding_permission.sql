-- 026_store_user_coding_permission.sql
--
-- إضافة شاشات مركزية جديدة (hqConsole, hqAnalytics, hqOrgChart,
-- hqBranchDetail, hqDocs, hqCoding) لا تحتاج عمودًا جديدًا: allowed_pages
-- الحالي مصفوفة jsonb من أي معرّفات نصية، فتوسيع PAGE_REGISTRY في
-- الفرونت وحده كافٍ لهذه الشاشات.
--
-- ⚠ لكن "إرسال تكويد لفرع" (hqCoding) فعلٌ تجاري خطير بما يكفي ليحتاج
-- تمييزًا مستقلًا عن مجرّد رؤية الشاشة — نفس مبرّر can_manage_branches
-- تمامًا (راجع 023_store_user_permissions.sql): رؤية شاشة التكويد لا
-- تعني بالضرورة صلاحية إرسال بضاعة فعليًّا لفرع. نضيف علمًا مستقلًا
-- بنفس النمط بدل تحميل allowedPages بمعنى مزدوج (شاشة + فعل).
--
-- ⚠ هذا امتدادٌ للنظام المبسّط الحالي عمدًا لا نظام أدوار كامل (SoD)
-- كالمرجع (chairman/gm/finance/operations/admin) — قرارٌ متّخذ صراحةً
-- (راجع محادثة توسيع صلاحيات المركزي). لو احتجنا لاحقًا فصل أدوار حقيقي
-- (عميل كبير بفريق مركزي متخصص)، أعمدة boolean منفصلة كهذه تتحوّل
-- بسهولة لاحقًا إلى فحصٍ مبني على عمود role موسَّع دون كسر البيانات
-- القائمة — كل عمود boolean يصير مجرد افتراضي لدورٍ معيّن حين نصل لذلك.
alter table store_users
  add column can_send_coding boolean not null default false;

-- ⚠ owner الحاليون يحتفظون بكل الصلاحيات صراحةً — نفس مبدأ الهجرة 023
-- تمامًا: لا يُفاجَأ owner بفقدان قدرته على إرسال تكويد فور هذه الهجرة.
update store_users set can_send_coding = true where role = 'owner';
