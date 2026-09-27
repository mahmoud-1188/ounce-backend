-- الوضع الخفي (المرجع 5.2.0): رقمٌ سرّيّ خاص يفتح على الجهاز المخزون والجرد وحدهما،
-- وما يُخرجه الجالس من الرفّ يُعلَّق حتى يُكمَل بيعه في الوضع الكامل أو يعيده المدير.
-- لا قيد ماليًّا ولا وزنيًّا للتعليق: القطعة ما زالت ملك المحل وفي 1210.
insert into roles (id, label, hint, can_manage_day, can_break, allowed_tabs, allowed_more, deny_actions) values
  ('hidden', 'الوضع الخفي', 'المخزون والجرد فقط — وما يُخرج منه يُعلَّق حتى يُكمَل بيعه', false, false,
   '["inventory", "stocktake"]'::jsonb, '[]'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;

alter table branch_settings add column if not exists hidden_mode_enabled boolean not null default true;
-- null = الرقم الافتراضي 123456 (يُنصح بتغييره)
alter table branch_settings add column if not exists hidden_pin_hash text;

alter table item_units add column if not exists held boolean not null default false;
alter table item_units add column if not exists held_at timestamptz;
alter table item_units add column if not exists held_by text;
alter table item_units add column if not exists held_ref text;
alter table item_units add column if not exists held_note text;
alter table item_units add column if not exists held_released_at timestamptz;
alter table item_units add column if not exists held_released_by uuid references users(id);
create index if not exists idx_item_units_held on item_units(item_id) where held;
