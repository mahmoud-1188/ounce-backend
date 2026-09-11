-- ============================================================
-- Ounce (أونصة) — PostgreSQL / Supabase schema
-- Generated from the verified frontend reference: keys.js, chart.js,
-- erp.js, money.js, data-model-spec.md.
-- Run this in the Supabase SQL Editor on a fresh project.
-- ============================================================

create extension if not exists pgcrypto; -- for gen_random_uuid()

-- ============================================================
-- 0. Branches (multi-tenant isolation from day one)
-- ============================================================

create table branches (
  id            uuid primary key default gen_random_uuid(),
  ref           text unique not null,
  name          text not null,
  is_hq         boolean default false,
  created_at    timestamptz default now()
);

create table users (
  id              uuid primary key default gen_random_uuid(),
  branch_id       uuid not null references branches(id),
  name            text not null,
  role            text not null check (role in ('employee','assistant','manager')),
  pin_hash        text not null,          -- hashed, never plaintext PIN
  allowed_tabs    jsonb default '[]',
  allowed_pages   jsonb default '[]',
  active          boolean default true,
  created_at      timestamptz default now()
);

create table hq_permissions (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  overrides     jsonb default '{}',
  updated_by    uuid references users(id),
  updated_at    timestamptz default now()
);

-- ============================================================
-- 1. Chart of Accounts (seeded reference data — see seed.sql)
-- ============================================================

create table accounts (
  code          text primary key,
  name          text not null,
  parent_code   text references accounts(code),
  unit          text not null check (unit in ('currency','gram','both')),
  nature        text not null check (nature in ('debit','credit')),
  statement     text not null check (statement in ('balance','income','offBalance')),
  is_group      boolean default false,
  pool          text check (pool in ('safe','daily','custody')),
  method        text check (method in ('cash','network')),
  note          text
);

create table posting_rules (
  op_type       text primary key,
  label         text not null,
  rule          jsonb not null   -- mirrors POSTING_RULES[op_type] from erp.js verbatim
);

-- allow-list of accounts a weight entry may touch (WEIGHT_ACCOUNTS in chart.js)
create table weight_accounts (
  account_code  text primary key references accounts(code)
);

-- ============================================================
-- 2. Business day (session envelope for every operation)
-- ============================================================

create table business_days (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  status        text not null default 'open' check (status in ('open','closed')),
  till_float    numeric(14,2) default 0,
  scrap_float   numeric(14,2) default 0,
  opened_by     uuid references users(id),
  opened_at     timestamptz not null default now(),
  closed_by     uuid references users(id),
  closed_at     timestamptz
);

create table stocktake_locks (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id) unique,
  locked        boolean default false,
  locked_by     uuid references users(id),
  locked_at     timestamptz
);

-- ============================================================
-- 3. Double-entry journal (cash ledger) + weight ledger (independent)
-- ============================================================

create table journal_entries (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id),
  business_day_id    uuid references business_days(id),
  op_type            text not null references posting_rules(op_type),
  ref_table          text,
  ref_id             uuid,
  description        text,
  created_by         uuid references users(id),
  created_at         timestamptz default now(),
  reversed_of        uuid references journal_entries(id)
);

create table journal_lines (
  id            uuid primary key default gen_random_uuid(),
  entry_id      uuid not null references journal_entries(id) on delete cascade,
  account_code  text not null references accounts(code),
  side          text not null check (side in ('debit','credit')),
  amount        numeric(14,2) not null check (amount > 0)
);

-- Enforce double-entry balance at the database level: no unbalanced
-- journal entry can ever be persisted, regardless of backend bugs.
create or replace function check_journal_balance() returns trigger as $$
declare
  v_entry_id uuid;
  v_debit numeric(14,2);
  v_credit numeric(14,2);
begin
  v_entry_id := coalesce(new.entry_id, old.entry_id);
  select coalesce(sum(amount) filter (where side = 'debit'), 0),
         coalesce(sum(amount) filter (where side = 'credit'), 0)
    into v_debit, v_credit
    from journal_lines where entry_id = v_entry_id;
  if v_debit <> v_credit then
    raise exception 'Unbalanced journal entry %: debit=% credit=%', v_entry_id, v_debit, v_credit;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger trg_journal_balance
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function check_journal_balance();

create table gold_ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id),
  business_day_id    uuid references business_days(id),
  op_type            text not null,
  karat              smallint not null check (karat in (24,22,21,18,14)),
  weight             numeric(12,3) not null,
  fine_weight        numeric(12,3) not null,
  from_account       text references accounts(code),
  to_account         text references accounts(code),
  ref_table          text,
  ref_id             uuid,
  note               text,
  created_by         uuid references users(id),
  created_at         timestamptz default now(),
  constraint gold_ledger_has_side check (from_account is not null or to_account is not null)
);

create table cash_tx (
  id                 uuid primary key default gen_random_uuid(),
  branch_id          uuid not null references branches(id),
  business_day_id    uuid references business_days(id),
  pool               text not null check (pool in ('safe','daily','custody')),
  method             text not null check (method in ('cash','network')),
  direction          text not null check (direction in ('in','out')),
  amount             numeric(14,2) not null check (amount > 0),
  category           text not null,
  note               text,
  ref_table          text,
  ref_id             uuid,
  created_by         uuid references users(id),
  created_at         timestamptz default now()
);

-- ============================================================
-- 4. Items / units / categories / lots
-- ============================================================

create table categories (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid references branches(id),  -- null = shared across branches
  name              text not null,
  sale_mode         text not null check (sale_mode in ('whole','partial','set')),
  min_sale_weight   numeric(12,3)
);

create table lots (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  supplier_id   uuid,   -- FK added after suppliers table
  date          date not null,
  created_by    uuid references users(id)
);

create table items (
  id                       uuid primary key default gen_random_uuid(),
  branch_id                uuid not null references branches(id),
  ref                      text unique not null,
  lot_id                   uuid references lots(id),
  category_id              uuid not null references categories(id),
  karat                    smallint not null check (karat in (24,22,21,18,14)),
  weight                   numeric(12,3) not null,
  stones_weight            numeric(12,3) default 0,
  cost_per_gram            numeric(14,4),
  workmanship              numeric(14,2) default 0,
  lot_workmanship_share    numeric(14,2) default 0,
  from_scrap               boolean default false,
  photo_url                text,               -- Object Storage link only, never a BLOB
  date_added               timestamptz default now(),
  business_day_id          uuid references business_days(id),
  created_by               uuid references users(id)
);

create table item_units (
  id            uuid primary key default gen_random_uuid(),
  item_id       uuid not null references items(id) on delete cascade,
  code          text unique not null,
  printed       boolean default false,
  sold          boolean default false
);

-- ============================================================
-- 5. Sales
-- ============================================================

create table customers (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  name          text not null,
  phone         text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table sales (
  id                   uuid primary key default gen_random_uuid(),
  branch_id            uuid not null references branches(id),
  ref                  text unique not null,
  business_day_id      uuid not null references business_days(id),
  date                 timestamptz default now(),
  customer_id          uuid references customers(id),
  customer_name        text,
  payment_method       text not null check (payment_method in ('cash','card','credit','split')),
  price24_snapshot     numeric(14,4) not null,
  price_frozen_at      timestamptz,
  card_network         text,
  cash_part            numeric(14,2) default 0,
  network_part         numeric(14,2) default 0,
  network_fee_pct      numeric(6,4) default 0,
  subtotal             numeric(14,2) not null,
  total                numeric(14,2) not null,
  tax_applicable       boolean default true,
  tax_rate             numeric(6,4) default 0.15,
  tax_amount           numeric(14,2) default 0,
  net_amount           numeric(14,2) not null,
  seller_id            uuid references users(id),
  seller_name          text,
  created_by           uuid references users(id)
);

create table sale_lines (
  id                        uuid primary key default gen_random_uuid(),
  sale_id                   uuid not null references sales(id) on delete cascade,
  item_id                   uuid not null references items(id),
  category                  text,
  karat                     smallint,
  quantity                  numeric(12,3) not null,
  unit_price                numeric(14,2) not null,
  weight_snapshot           numeric(12,3),
  cost_per_gram_snapshot    numeric(14,4),
  workmanship_snapshot      numeric(14,2)
);

create table returns (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  sale_id       uuid references sales(id),
  business_day_id uuid references business_days(id),
  amount        numeric(14,2) not null,
  weight        numeric(12,3),
  reason        text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table receipts (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  customer_id   uuid references customers(id),
  sale_id       uuid references sales(id),
  amount        numeric(14,2) not null,
  business_day_id uuid references business_days(id),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table reservations (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  customer_id   uuid references customers(id),
  item_id       uuid references items(id),
  deposit       numeric(14,2) not null,
  status        text default 'active' check (status in ('active','completed','cancelled')),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

-- ============================================================
-- 6. Suppliers / purchases / scrap custody chain
-- ============================================================

create table suppliers (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  name          text not null,
  phone         text,
  is_official   boolean default false,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

alter table lots add constraint lots_supplier_fk foreign key (supplier_id) references suppliers(id);

create table scrap_items (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id),
  ref               text unique not null,
  supplier_id       uuid references suppliers(id),
  karat_est         smallint,
  weight_est        numeric(12,3),
  karat_final       smallint,
  weight_final      numeric(12,3),
  stage             text not null default 'in_box'
                    check (stage in ('in_box','sent','assessed','approved','in_safe','used')),
  business_day_id   uuid references business_days(id),
  created_by        uuid references users(id),
  created_at        timestamptz default now()
);

create table scrap_custody (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  business_day_id uuid references business_days(id),
  direction     text check (direction in ('in','out')),
  amount        numeric(14,2) not null,
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table scrap_requests (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  status        text default 'pending',
  payload       jsonb,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table scrap_surplus (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  scrap_item_id uuid references scrap_items(id),
  weight_diff   numeric(12,3) not null,
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table repairs (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  customer_id   uuid references customers(id),
  weight_delta  numeric(12,3) not null,  -- positive = added, negative = removed
  fee           numeric(14,2) default 0,
  business_day_id uuid references business_days(id),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table weight_adjustments (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  item_id       uuid references items(id),
  delta         numeric(12,3) not null,
  reason        text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

-- ============================================================
-- 7. Safe / vault gold, taskir (تسكير) offices
-- ============================================================

create table safe_gold_tx (
  id             uuid primary key default gen_random_uuid(),
  branch_id      uuid not null references branches(id),
  business_day_id uuid references business_days(id),
  direction      text not null check (direction in ('in','out')),
  karat          smallint not null check (karat in (24,22,21,18,14)),
  weight         numeric(12,3) not null,
  destination    text,   -- required when direction = 'out' (enforced in backend)
  supplier_id    uuid references suppliers(id),
  note           text,
  created_by     uuid references users(id),
  created_at     timestamptz default now(),
  constraint safe_gold_out_needs_destination
    check (direction = 'in' or destination is not null)
);

create table taskir_offices (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  name          text not null,
  created_at    timestamptz default now()
);

create table taskir_entries (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  office_id     uuid references taskir_offices(id),
  weight         numeric(12,3),
  karat          smallint,
  business_day_id uuid references business_days(id),
  created_by     uuid references users(id),
  created_at     timestamptz default now()
);

create table taskir_office_tx (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  office_id     uuid references taskir_offices(id),
  direction     text check (direction in ('in','out')),
  amount        numeric(14,2),
  weight        numeric(12,3),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table safe_audits (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  counted_cash  numeric(14,2),
  counted_gold  numeric(12,3),
  diff_cash     numeric(14,2),
  diff_gold     numeric(12,3),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

-- ============================================================
-- 8. Trust gold (أمانة) — off-balance
-- ============================================================

create table trust_accounts (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  customer_id   uuid references customers(id),
  created_at    timestamptz default now()
);

create table trust_ledger (
  id                uuid primary key default gen_random_uuid(),
  trust_account_id  uuid not null references trust_accounts(id),
  direction         text check (direction in ('in','out')),
  weight            numeric(12,3),
  note              text,
  created_by        uuid references users(id),
  created_at        timestamptz default now()
);

-- ============================================================
-- 9. Partners
-- ============================================================

create table partners (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  name          text not null,
  share_pct     numeric(6,4),
  created_at    timestamptz default now()
);

create table partner_tx (
  id            uuid primary key default gen_random_uuid(),
  partner_id    uuid not null references partners(id),
  direction     text check (direction in ('in','out')),
  amount        numeric(14,2) not null,
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

-- ============================================================
-- 10. Fixed assets / depreciation / cost centers / budget
-- ============================================================

create table asset_classes (
  id            text primary key,        -- 'furniture','display',...
  label         text not null,
  account_code  text references accounts(code),
  years         smallint not null,
  salvage_pct   numeric(6,4) default 0
);

create table fixed_assets (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  class_id      text references asset_classes(id),
  name          text not null,
  cost          numeric(14,2) not null,
  purchased_at  date not null,
  disposed_at   date,
  created_by    uuid references users(id)
);

create table depreciation_schedule (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references fixed_assets(id) on delete cascade,
  period        date not null,
  amount        numeric(14,2) not null,
  posted        boolean default false,
  journal_entry_id uuid references journal_entries(id)
);

create table cost_centers (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  name          text not null
);

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  cost_center_id uuid references cost_centers(id),
  period        date not null,
  amount        numeric(14,2) not null
);

-- ============================================================
-- 11. Payroll / HR
-- ============================================================

create table gosi_rates (
  nationality   text primary key check (nationality in ('saudi','expat')),
  employee_pct  numeric(6,4) not null,
  employer_pct  numeric(6,4) not null
);

create table payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  period        date not null,
  status        text default 'draft' check (status in ('draft','approved','paid')),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

create table payroll_lines (
  id              uuid primary key default gen_random_uuid(),
  payroll_run_id  uuid not null references payroll_runs(id) on delete cascade,
  user_id         uuid references users(id),
  base_salary     numeric(14,2) not null,
  housing         numeric(14,2) default 0,
  transport       numeric(14,2) default 0,
  gosi_employee   numeric(14,2) default 0,
  gosi_employer   numeric(14,2) default 0,
  commission      numeric(14,2) default 0,
  net_pay         numeric(14,2) not null
);

create table attendance (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  user_id       uuid references users(id),
  date          date not null,
  check_in      timestamptz,
  check_out     timestamptz
);

create table leave_requests (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  user_id       uuid references users(id),
  type          text check (type in ('annual','sick','unpaid','emergency')),
  start_date    date not null,
  end_date      date not null,
  status        text default 'pending' check (status in ('pending','approved','rejected')),
  created_at    timestamptz default now()
);

create table commissions (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  user_id       uuid references users(id),
  basis         text check (basis in ('profit','sales')),
  rate          numeric(6,4) default 0,
  target        numeric(14,2) default 0,
  per_invoice   numeric(14,2) default 0
);

-- ============================================================
-- 12. Approvals / audit log
-- ============================================================

create table approval_rules (
  id            text primary key,      -- 'expense','asset_purchase',...
  label         text not null,
  threshold     numeric(14,2) default 0,
  approver_role text default 'manager'
);

create table approvals (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  rule_id       text references approval_rules(id),
  ref_table     text,
  ref_id        uuid,
  status        text default 'pending' check (status in ('pending','approved','rejected','executed','cancelled')),
  requested_by  uuid references users(id),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  created_at    timestamptz default now()
);

create table audit_log (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  event_type    text not null,  -- must match AUDIT_EVENTS keys — enforced in seed.sql via CHECK
  actor_id      uuid references users(id),
  ref_table     text,
  ref_id        uuid,
  details       jsonb,
  created_at    timestamptz default now()
);

-- ============================================================
-- 13. Opening balances / fiscal periods
-- ============================================================

create table opening_balances (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  account_code  text references accounts(code),
  amount        numeric(14,2),
  weight        numeric(12,3),
  as_of         date not null,
  created_by    uuid references users(id)
);

create table fiscal_closures (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  period        date not null,
  closed_by     uuid references users(id),
  closed_at     timestamptz default now()
);

create table period_close (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  period        date not null,
  locked        boolean default true,
  closed_by     uuid references users(id),
  closed_at     timestamptz default now()
);

-- ============================================================
-- 14. Expenses
-- ============================================================

create table expense_names (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid references branches(id),
  name          text not null
);

create table expenses (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text unique not null,
  name_id       uuid references expense_names(id),
  amount        numeric(14,2) not null,
  business_day_id uuid references business_days(id),
  created_by    uuid references users(id),
  created_at    timestamptz default now()
);

-- ============================================================
-- 15. Integrations / storefront / webhooks
-- ============================================================

create table store_links (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  platform      text,
  config        jsonb
);

create table store_orders (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  external_ref  text,
  status        text,
  payload       jsonb,
  created_at    timestamptz default now()
);

create table integrations (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  provider      text,
  config        jsonb
);

create table ext_invoices (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  sale_id       uuid references sales(id),
  external_id   text,
  status        text,
  created_at    timestamptz default now()
);

create table webhooks (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  event         text not null,   -- must match WEBHOOK_EVENTS ids
  url           text not null,
  secret        text,
  active        boolean default true
);

create table printers (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  name          text,
  config        jsonb
);

-- ============================================================
-- 16. Indexes
-- ============================================================

create index idx_items_branch_day on items(branch_id, business_day_id);
create index idx_sales_branch_day on sales(branch_id, business_day_id);
create index idx_cash_tx_branch_day on cash_tx(branch_id, business_day_id);
create index idx_gold_ledger_branch_day on gold_ledger_entries(branch_id, business_day_id);
create index idx_journal_entries_branch_day on journal_entries(branch_id, business_day_id);
create index idx_sale_lines_sale on sale_lines(sale_id);
create index idx_journal_lines_entry on journal_lines(entry_id);
create index idx_item_units_item on item_units(item_id);
create index idx_scrap_items_supplier on scrap_items(supplier_id);
create index idx_scrap_items_stage on scrap_items(stage);

-- ============================================================
-- 17. Row Level Security (branch isolation) — enable + policy
-- per operational table. Repeat this pattern for every table that
-- carries branch_id. Shown here for the highest-traffic tables;
-- apply identically to the rest before go-live.
-- ============================================================

alter table items enable row level security;
create policy branch_isolation_items on items
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table sales enable row level security;
create policy branch_isolation_sales on sales
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table cash_tx enable row level security;
create policy branch_isolation_cash_tx on cash_tx
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table gold_ledger_entries enable row level security;
create policy branch_isolation_gold_ledger on gold_ledger_entries
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

alter table journal_entries enable row level security;
create policy branch_isolation_journal on journal_entries
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- TODO before production: enable RLS + branch_isolation policy on every
-- remaining table listed in sections 4-15 above, following the exact
-- same pattern (uuid column name may vary; always branch_id here).
