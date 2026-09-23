-- 035_opening_mode.sql
--
-- وضع الافتتاح: محلٌّ جديد يُكوّد بضاعته القائمة قطعةً قطعة بلا مورد.
--
--   • lots.source — 'purchase' (الافتراضي: دفعة شراء من مورد) أو 'opening'
--     (دفعة افتتاحية بلا مورد ولا وزنٍ مشترى ولا سداد؛ وزنها وقيمتها
--     يتراكمان مما يُكوَّد فيها).
--   • lots.cost_ref — 'purchase' (تكلفة شراء فعلية) أو 'market' (قيّمت
--     بالسعر العالمي حين فُقدت التكلفة) — يُوسم على الدفعة.
--   • branch_settings.opening_mode / opening_finished_at — الوضع يعمل حتى
--     «إنهاء الافتتاح والبدء»، ولا يُفعَّل لفرعٍ باع فعلًا.
--   • posting_rules.opening_inventory — المكوَّد الافتتاحي يدخل المخزون
--     (1210) مقابل رأس المال (3100)، وزنًا إلى 1210.
--
-- آمنة للتشغيل أكثر من مرة.

alter table lots add column if not exists source text not null default 'purchase';
alter table lots drop constraint if exists lots_source_check;
alter table lots add constraint lots_source_check check (source in ('purchase','opening'));
alter table lots add column if not exists cost_ref text;
alter table lots drop constraint if exists lots_cost_ref_check;
alter table lots add constraint lots_cost_ref_check check (cost_ref is null or cost_ref in ('purchase','market'));

alter table branch_settings add column if not exists opening_mode boolean not null default false;
alter table branch_settings add column if not exists opening_finished_at timestamptz;

insert into posting_rules (op_type, label, rule) values
  ('opening_inventory', 'مخزون افتتاحي مكوَّد',
   '{"label": "مخزون افتتاحي مكوَّد", "cash": {"debit": "1210", "credit": "3100"}, "weight": {"from": null, "to": "1210"}, "note": "دفعةٌ بلا مورد — تُقفل عند «إنهاء الافتتاح والبدء»"}'::jsonb)
on conflict (op_type) do nothing;
