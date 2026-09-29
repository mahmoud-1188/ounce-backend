-- بيع جزءٍ من طقم · بقايا الأطقم للتكويد (المرجع 5.2.0 — قرار المالك 2026-09-29).
--
-- set_parts: مكوّنات الطقم كما اختارها المكوِّد [{ label, weight? }] — كانت تُختار في
--   التكويد ولا تُحفظ. يُعرف منها الجزء وقت بيعه.
-- remnant:   ما بقي من طقمٍ بِيع جزءٌ منه — مملوكٌ بوزنه وتكلفته (لا هالك ولا فائض)،
--   لا يُباع طقمًا كاملًا حتى يُكوَّد قطعًا مجموع أوزانها وزنه.
-- remnant_of: الطقم الأصل لبقايا جديدة نشأت من مرتجع جزءٍ بعد تكويد بقاياه.
-- sale_lines.part_label: «خاتم من طقم ‹رمز›» — سطر الجزء قطعةٌ واحدة بوزنها وسعرها.
alter table items add column if not exists set_parts jsonb not null default '[]'::jsonb;
alter table items add column if not exists remnant boolean not null default false;
alter table items add column if not exists remnant_of uuid references items(id);
alter table sale_lines add column if not exists part_label text;
create index if not exists idx_items_remnant on items (branch_id) where remnant = true;
