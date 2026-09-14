-- 015_fixed_assets.sql
--
-- يفعّل جدول fixed_assets الموجود أصلًا في schema.sql (قسم "10. Fixed
-- assets") منذ الإصدار الأول، لكنه كان بلا أي endpoint أو شاشة تستخدمه —
-- تمامًا مثل قارئ RFID قبل migration 014: بنية بيانات جاهزة ومصروفة على
-- posting_rules/asset_classes سلفًا، بانتظار الأسلاك الفعلية فقط.
--
-- ⚠ فجوة مرونة حقيقية بين الجدول الحالي والمرجع (AssetForm.js): المرجع
-- يسمح بتخصيص years/salvagePct/method لكل أصل على حدة (افتراضيًا من
-- فئته، لكن قابلة للتغيير — "العمر (سنوات) — {cls.years}" كـplaceholder
-- لا كقيمة مفروضة). جدولنا الحالي يستمد الثلاثة من asset_classes فقط
-- بلا استثناء لكل أصل، فيضيّق مرونة كانت موجودة فعليًا للمستخدم عند
-- الفريق السابق. نضيف أعمدة تخصيص اختيارية (NULL = اتّبع الفئة).
alter table fixed_assets add column if not exists years smallint;
alter table fixed_assets add column if not exists salvage_pct numeric(6,4);
alter table fixed_assets add column if not exists method text default 'straight'
  check (method in ('straight', 'declining'));

-- ⚠ نفس الملاحظة على تاريخ "بدء التشغيل": المرجع يستخدم حقلًا واحدًا
-- (inServiceDate) لكلٍّ من تاريخ الشراء وبداية الإهلاك معًا — لا فرق
-- بينهما في AssetForm. purchased_at الموجود يخدم الغرضين بلا حاجة لعمود
-- إضافي، فنُبقيه كما هو.

-- أعمدة الاستبعاد: disposed_at وحده (الموجود أصلًا) لا يكفي لإعادة بناء
-- الربح/الخسارة المعروضة في القائمة (a.disposalGain بالمرجع) — نحتاج
-- سبب الاستبعاد والمتحصّل والنتيجة المحسوبة وقت الاستبعاد نفسه (لا حسابها
-- كل مرة من جديد، فالحسابات المرجعية للأصل — قيمته الدفترية لحظتها — لا
-- تُستعاد بسهولة لاحقًا بعد أن يتوقف عن الإهلاك).
alter table fixed_assets add column if not exists disposal_reason text
  check (disposal_reason in ('sale', 'scrap'));
alter table fixed_assets add column if not exists disposal_proceeds numeric(14,2);
alter table fixed_assets add column if not exists disposal_gain numeric(14,2);
alter table fixed_assets add column if not exists disposal_funding_source text
  check (disposal_funding_source in ('safe_cash', 'safe_network'));
alter table fixed_assets add column if not exists disposed_by uuid references users(id);

-- لا حساب "ربح استبعاد أصل" مخصَّص في seed.sql — الأقرب دلاليًا 4210
-- ("ربح رأسمالي محقق من السعر") و4220/6810 لجهة الخسارة. لا نضيف حسابًا
-- جديدًا: نطابق 4210 لأنه ما يستخدمه فعليًا buildDisposalJournal.js
-- (سبق ووُجد جاهزًا في فرونت إندنا — انظر تعليق fixed-assets.routes.js).

-- شاشة "الأصول الثابتة" جديدة في allowed_more — بنفس نمط rfidReader/
-- rfidSettings تمامًا: صفحة يحكمها الفرونت إند فقط، والحارس الفعلي على
-- الخادم requireManager على كل endpoint (يطابق threshold=0 في
-- approval_rules.asset_purchase/asset_disposal المزروعة أصلًا — لا نظام
-- موافقات عام مُفعَّل في أي مكان آخر بالباك إند لنربط به، فـrequireManager
-- المباشر هو المكافئ العملي الوحيد الموجود فعلًا).
update roles
   set allowed_more = allowed_more || '["fixedAssets"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["fixedAssets"]'::jsonb);
