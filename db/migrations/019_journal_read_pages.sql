-- 019_journal_read_pages.sql
--
-- يسدّ فجوة صلاحيات حقيقية اكتُشفت أثناء بناء قراءة القيود الحقيقية
-- (bootstrap.routes.js + journal.routes.js — GET /api/journal): عدة شاشات
-- تقارير محاسبية نُقلت من مرجع العميل (الأستاذ العام، القوائم الكاملة،
-- كشف حساب لأي طرف، التقرير الشامل، الصرافة، تقرير العميل، دورة المستندات)
-- تُستخدَم فعليًا في الفرونت إند (كل واحدة لها فرع render حقيقي على
-- morePage في GoldInventoryApp.jsx) لكن معرّفات صفحاتها absent تمامًا من
-- allowed_more في migration 002 — أي أنه حتى لو فُتحت هذه الشاشات مستقبلًا
-- (زر تنقّل، أو AI_APP_MANUAL عبر onOpenScreen)، ستُرفض بصلاحية 403 من
-- requirePage رغم أن "journal"/"trialBalance"/"financials" فقط كانت مُتاحة.
--
-- ⚠ هذا لا يفتح أي endpoint جديد بذاته ولا يمنح صلاحية استخدام فعلي بعد —
-- الشاشات السبع أدناه معروضة في الفرونت إند لكن بلا أي زر/رابط تنقّل حقيقي
-- يصل إليها حاليًا (ثغرة في واجهة التنقّل نفسها، منفصلة عن هذا الإصلاح).
-- هذا السطر يضمن فقط أن الباك إند لا يرفضها بصلاحية حين تُوصَل لاحقًا.
--
-- يتبع تمامًا نمط 018_price_fix.sql: إضافة idempotent لمصفوفة allowed_more
-- الخاصة بالمدير فقط (نفس نطاق كل شاشات التقارير/الإدارة الأخرى).
update roles
   set allowed_more = allowed_more
     || '["generalLedger","fullStatements","anyStatement","masterReport","exchange","customerReport","docCycle"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["generalLedger"]'::jsonb);
