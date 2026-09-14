-- Migration 012 — تحويل كسر لمخزون قابل للبيع (handleConvertScrap).
--
-- كان هذا آخر جزء من دورة الكسر لا يزال محليًا بالكامل (window.storage) —
-- يختفي بعد إعادة تحميل الصفحة تمامًا كسبب البلاغ الأصلي عن الخزنة. لا
-- يوجد أي مسار كتابة لجدول items في المشروع كله قبل هذي الهجرة (لا هنا
-- ولا في purchases.routes.js) — هذا أول endpoint يكتب فيه فعليًا.

alter table scrap_items add column if not exists consumed_at timestamptz;
alter table scrap_items add column if not exists consumed_by uuid references users(id);
alter table scrap_items add column if not exists converted_item_id uuid references items(id);
