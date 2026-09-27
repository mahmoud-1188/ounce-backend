-- التحويل بين الفروع (المرجع 5.2.0: branchTransfer): قطعٌ تُرسَل لفرعٍ آخر في المتجر نفسه
-- وتُستلم هناك — القطعة نفسها (رمزها وملصقها) تنتقل، لا نسخة.
--   المرسِل: مدين 1350 ذهبٌ لدى فروع أخرى / دائن 5110 المشتريات — بتكلفتها
--   المستلم: مدين 5110 المشتريات / دائن 2140 فروعٌ أخرى — بضاعة مستلمة
-- فيتقابل 1350 و2140 في الميزان الموحّد، وتنتقل التكلفة مع القطعة.
insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method) values
  ('2140', 'فروعٌ أخرى — بضاعة مستلمة', '2100', 'currency', 'credit', 'balance', false, null, null)
on conflict (code) do nothing;

insert into posting_rules (op_type, label, rule) values
  ('branch_transfer_out', 'تحويل قطع إلى فرع', '{"label": "تحويل قطع إلى فرع", "cash": {"debit": "1350", "credit": "5110"}, "weight": {"from": "1210", "to": "1350"}}'::jsonb),
  ('branch_transfer_in', 'استلام قطع من فرع', '{"label": "استلام قطع من فرع", "cash": {"debit": "5110", "credit": "2140"}, "weight": {"from": null, "to": "1210"}}'::jsonb),
  ('branch_transfer_cancel', 'إلغاء تحويل قطع', '{"label": "إلغاء تحويل قطع", "cash": {"debit": "5110", "credit": "1350"}, "weight": {"from": "1350", "to": "1210"}}'::jsonb)
on conflict (op_type) do nothing;

create table if not exists branch_transfers (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  store_id uuid references stores(id),
  from_branch_id uuid not null references branches(id),
  to_branch_id uuid not null references branches(id),
  status text not null default 'sent' check (status in ('sent', 'received', 'cancelled')),
  lines jsonb not null,
  pieces int not null default 0,
  total_weight numeric(12,3) not null default 0,
  total_fine numeric(12,3) not null default 0,
  total_cost numeric(14,2) not null default 0,
  note text,
  sent_by uuid references users(id), sent_by_name text, sent_at timestamptz not null default now(),
  received_by uuid references users(id), received_by_name text, received_at timestamptz,
  cancelled_at timestamptz,
  constraint branch_transfer_distinct check (from_branch_id <> to_branch_id)
);
create index if not exists idx_branch_transfers_from on branch_transfers(from_branch_id, status);
create index if not exists idx_branch_transfers_to on branch_transfers(to_branch_id, status);
alter table item_units add column if not exists transfer_id uuid references branch_transfers(id);

-- 1350 «ذهب لدى فروع أخرى» حسابٌ وزنيّ: القطعة في الطريق بين الفروع
insert into weight_accounts (account_code) select '1350' where not exists (select 1 from weight_accounts where account_code = '1350');
