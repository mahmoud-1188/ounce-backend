-- الفوترة الإلكترونية — المرحلة الثانية من «فاتورة» (المرجع 5.2.0: EInvoicePage).
-- لكل مستندٍ (فاتورة مبسّطة 388 · إشعار دائن 381) UUID وعدّادٌ متسلسل (ICV) وتجزئة
-- سابقه (PIH، SHA-256) — تُصدر على الخادم داخل معاملة البيع/المرتجع نفسها فلا تتفرّع
-- السلسلة بين أجهزة الفرع. بيانات البائع تُحفظ كما كانت لحظة الإصدار.
create table if not exists einvoices (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  icv         integer not null,
  type        text not null check (type in ('388', '381')),
  ref_table   text not null check (ref_table in ('sales', 'returns')),
  ref_id      uuid not null,
  ref         text not null,
  uuid        uuid not null,
  pih         text not null,
  hash        text not null,
  qr          text not null,
  total       numeric(14,2) not null,
  vat         numeric(14,2) not null,
  doc_date    timestamptz not null,
  info        jsonb not null default '{}'::jsonb,
  z_reason    text not null default '36',
  issued_at   timestamptz not null default now(),
  unique (branch_id, icv),
  unique (branch_id, ref_table, ref_id)
);
create index if not exists idx_einvoices_branch on einvoices (branch_id, icv desc);
alter table einvoices enable row level security;
drop policy if exists branch_isolation_einvoices on einvoices;
create policy branch_isolation_einvoices on einvoices
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- بداية السلسلة: أوّل مستندٍ بعد تفعيل الوحدة — المبيعات السابقة لا تُسلسل بأثرٍ رجعي
alter table branch_settings add column if not exists einvoice_since timestamptz;

-- شاشة الفوترة الإلكترونية في صلاحيات المدير والمحاسب
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["einvoice"]'::jsonb) v) where id in ('manager', 'accountant');
