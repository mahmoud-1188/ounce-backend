-- 043: سعر الاشتراك وسجل مدفوعاته (لوحة الأدمن)
--
-- السعر الشهري للمتجر = الأساسي + (سعر الفرع × الفروع المحتسبة)
-- الفروع المحتسبة = الفروع العاملة (غير المحذوفة)، وفرعٌ واحد على الأقل.
-- المدفوعات تُسجَّل مع كل تجديد (أو منفردة)، ولا تُحذف — تُلغى بسبب.
alter table stores add column if not exists price_base numeric(12,2) not null default 0 check (price_base >= 0);
alter table stores add column if not exists price_per_branch numeric(12,2) not null default 0 check (price_per_branch >= 0);

create table if not exists subscription_payments (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references stores(id),
  amount       numeric(12,2) not null check (amount > 0),
  months       integer check (months is null or months >= 0),
  method       text not null default 'transfer' check (method in ('transfer', 'cash', 'card', 'other')),
  note         text,
  paid_at      timestamptz not null default now(),
  admin_id     uuid references platform_admins(id),
  voided_at    timestamptz,
  voided_by    uuid references platform_admins(id),
  void_reason  text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_subscription_payments_store on subscription_payments(store_id, paid_at desc);
