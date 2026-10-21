-- الإقرار الموحّد للمنشأة: الإدارة تختار «إقرارٌ واحد»، فيحوّل كل فرعٍ صافي ضريبته للإدارة (بدل الهيئة)،
-- وتستلمه الإدارة في دفترها التزامًا للهيئة (2225)، ثم تسدّد الإدارة الإقرار الموحّد مرّةً واحدة.
alter table stores add column if not exists vat_filing text not null default 'branch';
alter table stores drop constraint if exists stores_vat_filing_check;
alter table stores add constraint stores_vat_filing_check check (vat_filing in ('branch', 'group'));

insert into accounts (code, name, parent_code, unit, nature, statement, is_group)
values ('2225', 'ضريبة محوّلة من الفروع — مستحقة للهيئة', '2200', 'currency', 'credit', 'balance', false)
on conflict (code) do nothing;

alter table vat_settlements add column if not exists to_hq boolean not null default false;
alter table vat_settlements add column if not exists hq_txn_id uuid;
alter table vat_settlements add column if not exists group_id uuid;
alter table hq_transactions add column if not exists vat_settlement_id uuid;

create table if not exists group_vat_settlements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  hq_branch_id uuid not null references branches(id),
  period_from date not null,
  period_to date not null,
  hq_output numeric(14,2) not null default 0,
  hq_input numeric(14,2) not null default 0,
  branches_total numeric(14,2) not null default 0,
  paid numeric(14,2) not null default 0,
  source text not null,
  entry_id uuid,
  detail jsonb not null default '[]'::jsonb,
  created_by_store_user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_group_vat_store on group_vat_settlements(store_id, period_from);

insert into posting_rules (op_type, label, rule) values
  ('vat_to_hq', 'تحويل ضريبة الفرع للإدارة', '{"cash": {"debit": "2220", "credit": "1110"}, "weight": null}'),
  ('vat_from_branch', 'استلام ضريبة فرعٍ للإقرار الموحّد', '{"cash": {"debit": "1110", "credit": "2225"}, "weight": null}'),
  ('group_vat_settlement', 'سداد الإقرار الموحّد للهيئة', '{"cash": {"debit": "2225", "credit": "1160"}, "weight": null}')
on conflict (op_type) do nothing;
