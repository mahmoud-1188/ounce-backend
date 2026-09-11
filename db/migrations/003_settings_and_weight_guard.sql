-- ============================================================
-- 003: Branch settings (tax rate, card fees) + weight-ledger
-- account allow-list enforcement.
--
-- branch_settings didn't exist yet — it's needed the moment any real
-- money-moving endpoint (sales, purchases) has to know the VAT rate or a
-- card network's fee percentage, both of which are per-branch settings
-- in the reference app (SETTINGS_KEY / DEFAULT_SETTINGS in constants.js).
-- ============================================================

create table branch_settings (
  branch_id     uuid primary key references branches(id),
  tax_enabled   boolean not null default true,
  tax_rate      numeric(6,4) not null default 0.15,
  -- card network id -> fee percentage, e.g. {"mada":0,"visa":2.5,"mastercard":2.5,"amex":3.5}
  -- values transcribed verbatim from CARD_NETWORKS.defaultFee in money-rules.js
  card_fees     jsonb not null default '{"mada":0,"visa":2.5,"mastercard":2.5,"amex":3.5}'
);

-- Every branch needs a settings row (the app reads defaults otherwise);
-- keep it in sync automatically so a newly created branch is never missing one.
create or replace function ensure_branch_settings() returns trigger as $$
begin
  insert into branch_settings (branch_id) values (new.id)
  on conflict (branch_id) do nothing;
  return new;
end;
$$ language plpgsql;

create trigger trg_branch_settings_default
  after insert on branches
  for each row execute function ensure_branch_settings();

-- Backfill for branches created before this migration.
insert into branch_settings (branch_id)
  select id from branches
  on conflict (branch_id) do nothing;

-- ============================================================
-- Weight-ledger account allow-list, actually enforced (schema.sql
-- created the weight_accounts table as a reference list but never wired
-- it to gold_ledger_entries — a plain CHECK can't subquery another
-- table in Postgres, so this needs a trigger).
-- ============================================================

create or replace function check_weight_account() returns trigger as $$
begin
  if new.from_account is not null and not exists (
    select 1 from weight_accounts where account_code = new.from_account
  ) then
    raise exception 'account % is not weight-eligible (from_account) — see WEIGHT_ACCOUNTS in chart.js', new.from_account;
  end if;
  if new.to_account is not null and not exists (
    select 1 from weight_accounts where account_code = new.to_account
  ) then
    raise exception 'account % is not weight-eligible (to_account) — see WEIGHT_ACCOUNTS in chart.js', new.to_account;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_weight_account_allowlist
  before insert or update on gold_ledger_entries
  for each row execute function check_weight_account();
