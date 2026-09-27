-- 045: استعلام القطع (المرجع 5.2.0 — PieceInquiryPage)
--
-- الوحدة تحمل فاتورة بيعها: كان البيع يُعلّم أيّ N وحدةٍ مباعة بلا ربط، فلا يُعرف
-- لأي فاتورةٍ وعميلٍ بيعت قطعةٌ بعينها، والمرتجع يُعيد وحدةً غير التي بيعت.
alter table item_units add column if not exists sale_id uuid references sales(id);
create index if not exists idx_item_units_sale on item_units(sale_id) where sale_id is not null;

-- الشاشة للأدوار التي ترى المخزون (قراءةٌ فقط)
update roles set allowed_more = (
  select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["pieceInquiry"]'::jsonb) v
) where id in ('manager', 'assistant', 'accountant', 'employee');
