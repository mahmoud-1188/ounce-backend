-- Migration 007 — البيع الجزئي (بالوزن) وبيع "بدل بكسر" (Trade-in) —
-- آخر بندين مؤجَّلين من endpoint البيع الأصلي.

-- ============================================================
-- 1. sales — طريقة دفع جديدة "trade_in" (لا "scrap" كتسمية المرجع، أوضح
-- هنا لأنها لا تعني فعليًا "دفع بكسر من عهدة الكسر" كما في الشراء، بل
-- "قبول كسر من العميل كجزء من السداد") + عمود لقيمة الكسر المقبوض.
-- ============================================================

alter table sales drop constraint if exists sales_payment_method_check;
alter table sales add constraint sales_payment_method_check
  check (payment_method in ('cash','card','credit','split','trade_in'));

alter table sales add column if not exists trade_in_value numeric(14,2) default 0;

-- ============================================================
-- 2. scrap_items — تمييز أصل القطعة (شراء عادي من عميل عبر scrapIntake،
-- أو بدل بكسر داخل فاتورة بيع) + ربط بالفاتورة المصدر.
-- ⚠ "trade_in" أُضيف أيضًا لقائمة payment_method المسموحة لأن قيمة
-- الكسر هنا لا تُدفع نقدًا أو شبكة فعليًا — تُقاصّ من إجمالي الفاتورة
-- نفسها (لا حركة نقد مستقلة لها).
-- ============================================================

alter table scrap_items add column if not exists source text not null default 'buy'
  check (source in ('buy','trade_in'));
alter table scrap_items add column if not exists sale_id uuid references sales(id);

alter table scrap_items drop constraint if exists scrap_items_payment_method_check;
alter table scrap_items add constraint scrap_items_payment_method_check
  check (payment_method in ('cash','network','trade_in'));

-- ============================================================
-- 3. posting_rules — سطر جديد لـ"sale_trade_in".
-- ⚠ نفس درس migration 006 (قيد FK حقيقي journal_entries.op_type →
-- posting_rules(op_type)، مكتشَف أثناء تشغيل فعلي لا نظريًا): أي op_type
-- جديد يُستخدَم في postJournalEntry يحتاج سطرًا هنا أولًا، وإلا رُفض
-- الإدراج بـ23503 عند أول تشغيل حقيقي.
--
-- الحسابات هنا متغيّرة فعليًا حسب الفرق (نقد داخل/خارج) وقيمة الكسر —
-- الحقل `rule` توثيقي، يُبنى القيد الفعلي في كود الـendpoint (بقرارك
-- الصريح: مدين 1230 بقيمة الكسر النقدية + مدين/دائن 1130 بالفرق فقط،
-- ضمن نفس قيد الفاتورة، لا قيد منفصل — حساب 1230 مُعلَّم unit:"both" في
-- شجرة الحسابات، أي يُتابَع نقديًا ووزنيًا معًا، فهذا استخدام صحيح له).
insert into posting_rules (op_type, label, rule) values
  ('sale_trade_in', 'بيع بدل بكسر',
   '{"label": "بيع بدل بكسر", "cash": null, "weight": {"from": "1210", "to": null},
     "note": "مدين 1230 بقيمة الكسر النقدية + مدين/دائن 1130 بالفرق فقط، ضمن قيد الفاتورة نفسه — لا قيد منفصل"}'::jsonb)
on conflict (op_type) do nothing;
