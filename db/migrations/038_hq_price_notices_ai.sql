-- 038_hq_price_notices_ai.sql
--
-- تحكّم الإدارة بالفروع والمساعد المحاسبي (v197 في المرجع):
--
--   ① زيادة الإدارة على السعر العالمي — لكل متجر: سعر العمل في كل فروعه
--      = العالمي (آلي أو يدوي تحدّده الإدارة) + زيادة (ريال/جم أو ٪).
--      الخادم يُعيدها مع كل جلبٍ للسعر فتُطبَّق آليًّا.
--   ② إعلانات الإدارة — تظهر في رئيسية كل فرع حتى تاريخ انتهائها.
--   ③ سجل الصلاحيات يقبل نوعين جديدين: إعادة الرقم السري، والتفعيل/التعطيل
--      (أوامر الإدارة لمستخدمي الفرع).
--   ④ مسودّات المساعد المحاسبي — تُكتب هنا فقط، ولا تصير قيدًا إلا بالاعتماد
--      البشري (مدير أو محاسب)، ويُدوَّن من اعتمد.
--   ⑤ قاعدة ترحيل «قيد تسوية» لما يُعتمد من المسودّات.
--
-- آمنة للتشغيل أكثر من مرة.

-- ① ─────────────────────────────────────────────────────────────
alter table stores add column if not exists price_markup_mode text not null default 'amount';
alter table stores add column if not exists price_markup_value numeric(12,4) not null default 0;
alter table stores add column if not exists price_world24_manual numeric(14,4);
alter table stores add column if not exists price_policy_at timestamptz;
alter table stores add column if not exists price_policy_by text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stores_price_markup_mode_check') then
    alter table stores add constraint stores_price_markup_mode_check check (price_markup_mode in ('amount','percent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'stores_price_markup_value_check') then
    alter table stores add constraint stores_price_markup_value_check check (price_markup_value >= 0);
  end if;
end $$;

-- ② ─────────────────────────────────────────────────────────────
create table if not exists store_notices (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references stores(id),
  text        text not null check (length(trim(text)) > 0),
  created_by  text,
  created_at  timestamptz not null default now(),
  until       timestamptz not null
);
create index if not exists store_notices_store_idx on store_notices(store_id, until desc);

-- ③ ─────────────────────────────────────────────────────────────
alter table permission_log drop constraint if exists permission_log_kind_check;
alter table permission_log add constraint permission_log_kind_check
  check (kind in ('create','delete','role','pages','reset','ai','rename','enroll','pin','activate'));

-- ④ ─────────────────────────────────────────────────────────────
create table if not exists ai_proposals (
  id               uuid primary key default gen_random_uuid(),
  branch_id        uuid not null references branches(id),
  requested_by     uuid references users(id),
  requested_name   text,
  question         text,
  lines            jsonb not null,
  note             text,
  total_debit      numeric(14,2) not null default 0,
  total_credit     numeric(14,2) not null default 0,
  status           text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by       uuid references users(id),
  decided_name     text,
  decided_at       timestamptz,
  decision_note    text,
  journal_entry_id uuid references journal_entries(id),
  created_at       timestamptz not null default now()
);
create index if not exists ai_proposals_branch_idx on ai_proposals(branch_id, status, created_at desc);
alter table ai_proposals enable row level security;
drop policy if exists branch_isolation_ai_proposals on ai_proposals;
create policy branch_isolation_ai_proposals on ai_proposals
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ⑤ ─────────────────────────────────────────────────────────────
insert into posting_rules (op_type, label, rule) values
  ('manual_adjustment', 'قيد تسوية (اقتراح المساعد المحاسبي)',
   '{"label": "قيد تسوية (اقتراح المساعد المحاسبي)", "cash": null, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

-- المساعد المحاسبي للمدير والمحاسب
update roles set allowed_more = (
  select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["aiAccountant"]'::jsonb) v
) where id in ('manager', 'accountant');
