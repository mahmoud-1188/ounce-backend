-- أوامر الشراء (المرجع 5.2.0: purchaseOrders): أمرٌ للمورد بالمطلوب، ثم استلامه شراءً فعليًّا
-- بمعالج الشراء نفسه — ويُقارن المطلوب بالمستلم. لا قيد عند الأمر (التزامٌ غير مالي بعد).
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  ref text not null,
  supplier_id uuid not null references suppliers(id),
  lines jsonb not null,
  total_weight numeric(12,3) not null default 0,
  est_total numeric(14,2) not null default 0,
  status text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  expected_date date,
  note text,
  purchase_id uuid references purchases(id),
  received_weight numeric(12,3),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_purchase_orders_branch on purchase_orders(branch_id, status);
alter table purchase_orders enable row level security;
drop policy if exists branch_isolation_purchase_orders on purchase_orders;
create policy branch_isolation_purchase_orders on purchase_orders using (branch_id = current_setting('app.current_branch_id', true)::uuid);
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["purchaseOrders"]'::jsonb) v) where id = 'manager';
