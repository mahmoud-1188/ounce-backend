-- الطلبات الخاصة والتصنيع (المرجع 5.2.0: customOrders): طلب عميلٍ بمواصفة وعربون وموعد،
-- مراحل الورشة، ثم التسليم بفاتورةٍ يُخصم منها العربون (2210) كعربون الحجز تمامًا.
create table if not exists custom_orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  ref text not null,
  customer_id uuid not null references customers(id),
  description text not null,
  karat smallint check (karat in (24,22,21,18,14)),
  est_weight numeric(12,3),
  est_price numeric(14,2),
  deposit numeric(14,2) not null default 0,
  deposit_method text,
  deposit_used numeric(14,2) not null default 0,
  due_date date,
  stage text not null default 'received' check (stage in ('received', 'design', 'workshop', 'ready', 'delivered', 'cancelled')),
  stage_log jsonb not null default '[]'::jsonb,
  sale_id uuid references sales(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_custom_orders_branch on custom_orders(branch_id, stage);
alter table custom_orders enable row level security;
drop policy if exists branch_isolation_custom_orders on custom_orders;
create policy branch_isolation_custom_orders on custom_orders using (branch_id = current_setting('app.current_branch_id', true)::uuid);
alter table sales add column if not exists custom_order_id uuid references custom_orders(id);
insert into posting_rules (op_type, label, rule) values
  ('custom_order_deposit', 'عربون طلبٍ خاص', '{"label": "عربون طلبٍ خاص", "cash": {"debit": "1130", "credit": "2210"}, "weight": null}'::jsonb),
  ('custom_order_refund', 'ردّ عربون طلبٍ خاص', '{"label": "ردّ عربون طلبٍ خاص", "cash": {"debit": "2210", "credit": "1130"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["customOrders"]'::jsonb) v) where id in ('manager', 'assistant', 'employee');
