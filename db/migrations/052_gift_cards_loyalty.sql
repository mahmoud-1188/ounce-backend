-- بطاقات الهدايا ونقاط الولاء (المرجع 5.2.0: giftCards · loyalty)
--   بيع بطاقة: مدين الصندوق (1130/1140) / دائن 2260 بطاقات الهدايا — التزامٌ حتى تُستعمل
--   الدفع بها في فاتورة: مدين 2260 بدل النقد
--   استبدال النقاط ببطاقة: مدين 6950 تكلفة برامج الولاء / دائن 2260
insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method) values
  ('2260', 'بطاقات الهدايا — أرصدة غير مستعملة', '2200', 'currency', 'credit', 'balance', false, null, null),
  ('6950', 'تكلفة برامج الولاء', '6000', 'currency', 'debit', 'income', false, null, null)
on conflict (code) do nothing;

insert into posting_rules (op_type, label, rule) values
  ('gift_card_sell', 'بيع بطاقة هدية', '{"label": "بيع بطاقة هدية", "cash": {"debit": "1130", "credit": "2260"}, "weight": null}'::jsonb),
  ('loyalty_redeem', 'استبدال نقاط الولاء', '{"label": "استبدال نقاط الولاء", "cash": {"debit": "6950", "credit": "2260"}, "weight": null}'::jsonb),
  ('gift_card_void', 'إلغاء بطاقة هدية', '{"label": "إلغاء بطاقة هدية", "cash": {"debit": "2260", "credit": "1130"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

create table if not exists gift_cards (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  code text not null unique,
  initial_amount numeric(14,2) not null check (initial_amount > 0),
  balance numeric(14,2) not null check (balance >= 0),
  customer_id uuid references customers(id),
  source text not null default 'sold' check (source in ('sold', 'loyalty')),
  status text not null default 'active' check (status in ('active', 'used', 'void')),
  payment_method text,
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table if not exists gift_card_tx (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references gift_cards(id),
  kind text not null check (kind in ('issue', 'redeem', 'void')),
  amount numeric(14,2) not null,
  sale_id uuid references sales(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create table if not exists loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id),
  customer_id uuid not null references customers(id),
  points int not null,
  sale_id uuid references sales(id),
  gift_card_id uuid references gift_cards(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_loyalty_customer on loyalty_ledger(customer_id);
alter table sales add column if not exists gift_card_id uuid references gift_cards(id);
alter table sales add column if not exists gift_applied numeric(14,2) not null default 0;

alter table gift_cards enable row level security;
drop policy if exists branch_isolation_gift_cards on gift_cards;
create policy branch_isolation_gift_cards on gift_cards using (branch_id = current_setting('app.current_branch_id', true)::uuid);
alter table loyalty_ledger enable row level security;
drop policy if exists branch_isolation_loyalty on loyalty_ledger;
create policy branch_isolation_loyalty on loyalty_ledger using (branch_id = current_setting('app.current_branch_id', true)::uuid);
