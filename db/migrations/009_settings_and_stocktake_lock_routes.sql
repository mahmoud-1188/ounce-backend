-- 009_settings_and_stocktake_lock_routes.sql
--
-- الفجوة: sales.routes.js و scrap.routes.js يقرآن ويُطبّقان فعليًا كلًا من
-- branch_settings (نسبة الضريبة، رسوم الشبكة) و stocktake_locks (قفل الجرد)
-- على كل عملية بيع/كسر — لكن لم يوجد قط أي route لكتابتهما. الواجهة كانت
-- تُغيّر هذه القيم محليًا فقط (localStorage)، فتغيير الضريبة أو فتح/قفل
-- الجرد من الشاشة لا يصل إطلاقًا للسيرفر الذي يفرضهما فعلًا. هذا الملف لا
-- يُغيّر شكل الجدولين (already exist من 003 و schema.sql الأساسي) — فقط
-- يُضيف RLS الناقص عليهما (كانا الاستثناء الوحيد المتبقي من TODO الأصلي في
-- schema.sql سطر ~769) تمهيدًا لإضافة routes الكتابة عليهما.

alter table branch_settings enable row level security;
create policy branch_isolation_branch_settings on branch_settings
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table stocktake_locks enable row level security;
create policy branch_isolation_stocktake_locks on stocktake_locks
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
