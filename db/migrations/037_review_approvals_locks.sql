-- 037_review_approvals_locks.sql
--
-- قسم المحاسب والرقابة (v197 في المرجع) على الخادم:
--
--   ① reviews — أحكام المراجعة المحاسبية: تُضاف ولا تُعدَّل (append-only).
--      «معتمد» يُخرج البند من الطابور ما لم تتغيّر بصمته، و«يحتاج تعديلًا»
--      يُبقيه موسومًا، و«ملاحظة» توثيقٌ بلا حكم. سبب فرق الجرد يُكتب هنا.
--   ② approvals — كان الجدول موجودًا بلا استعمال؛ تُضاف حقول الطلب
--      (المبلغ، الحمولة، الطالب، القرار) ليعمل الاعتماد فعليًّا: ما فوق
--      الحدّ لا يُنفَّذ بل يُحفظ طلبًا، وبعد الاعتماد يُنفَّذ مرةً واحدة.
--   ③ branch_settings — تفعيل الاعتماد وحدوده، وقفل الفترات بالتاريخ:
--      lock_all (نهائي للجميع) وlock_posted (لا يعدّل فيها إلا المدير).
--   ④ permission_log — من منح من ماذا ومتى (الفرق لا الحالة).
--   ⑤ enroll_invites — دعوة ربط جهاز الموظّف بـQR: الموظّف يضع رقمه
--      السري على جهازه ولا يعرفه المدير. الرمز يُخزَّن مُجزَّأً فقط.
--   ⑥ branches.locked — قفل الفرع من الإدارة مع السبب: شاشة قفلٍ تحجب
--      كل شيء، والخادم يرفض طلبات الفرع حتى يُفكّ.
--   ⑦ دور المحاسب — يراجع ويحكم ولا يبيع ولا يقبض ولا يُكوّد.
--   ⑧ قاعدتا تسوية عمولة البنك (زيادة/نقص على رصيد الشبكة).
--
-- آمنة للتشغيل أكثر من مرة.

-- ① ─────────────────────────────────────────────────────────────
create table if not exists reviews (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  key           text not null,
  kind          text not null,
  target_id     text,
  target_ref    text,
  target_date   timestamptz,
  label         text,
  why           text,
  amount        numeric(14,2) default 0,
  verdict       text not null check (verdict in ('approved','needs_change','note')),
  note          text,
  fingerprint   text,
  reviewer_id   uuid references users(id),
  reviewer_name text,
  reviewer_role text,
  business_day_id uuid references business_days(id),
  created_at    timestamptz not null default now()
);
create index if not exists reviews_branch_key_idx on reviews(branch_id, key, created_at);
alter table reviews enable row level security;
drop policy if exists branch_isolation_reviews on reviews;
create policy branch_isolation_reviews on reviews
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- سجلٌّ لا يُعدَّل: لا تحديث ولا حذف
create or replace function reviews_append_only() returns trigger as $$
begin
  raise exception 'reviews are append-only';
end;
$$ language plpgsql;
drop trigger if exists trg_reviews_append_only on reviews;
create trigger trg_reviews_append_only before update or delete on reviews
  for each row execute function reviews_append_only();

-- ② ─────────────────────────────────────────────────────────────
alter table approvals add column if not exists ref text;
alter table approvals add column if not exists amount numeric(14,2) default 0;
alter table approvals add column if not exists payload jsonb;
alter table approvals add column if not exists note text;
alter table approvals add column if not exists requester_name text;
alter table approvals add column if not exists requester_role text;
alter table approvals add column if not exists approver_kind text default 'manager';
alter table approvals add column if not exists approver_name text;
alter table approvals add column if not exists decision_note text;
alter table approvals add column if not exists self_approved boolean not null default false;
alter table approvals add column if not exists executed_at timestamptz;
create index if not exists approvals_branch_status_idx on approvals(branch_id, status, created_at);

-- ③ ─────────────────────────────────────────────────────────────
alter table branch_settings add column if not exists approvals_enabled boolean not null default true;
alter table branch_settings add column if not exists approval_thresholds jsonb not null default '{}'::jsonb;
alter table branch_settings add column if not exists lock_all date;
alter table branch_settings add column if not exists lock_posted date;

-- ④ ─────────────────────────────────────────────────────────────
create table if not exists permission_log (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  target_id     uuid,
  target_name   text,
  kind          text not null check (kind in ('create','delete','role','pages','reset','ai','rename','enroll')),
  before        jsonb,
  after         jsonb,
  added         jsonb,
  removed       jsonb,
  actor_id      uuid,
  actor_name    text,
  actor_kind    text default 'branch',
  created_at    timestamptz not null default now()
);
create index if not exists permission_log_branch_idx on permission_log(branch_id, created_at desc);
alter table permission_log enable row level security;
drop policy if exists branch_isolation_permission_log on permission_log;
create policy branch_isolation_permission_log on permission_log
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ⑤ ─────────────────────────────────────────────────────────────
create table if not exists enroll_invites (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  user_id       uuid not null references users(id),
  code_hash     text not null unique,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now()
);
create index if not exists enroll_invites_user_idx on enroll_invites(user_id, created_at desc);
alter table enroll_invites enable row level security;
drop policy if exists branch_isolation_enroll_invites on enroll_invites;
create policy branch_isolation_enroll_invites on enroll_invites
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ⑥ ─────────────────────────────────────────────────────────────
alter table branches add column if not exists locked boolean not null default false;
alter table branches add column if not exists lock_reason text;
alter table branches add column if not exists locked_at timestamptz;
alter table branches add column if not exists locked_by text;

-- ⑦ ─────────────────────────────────────────────────────────────
insert into roles (id, label, hint, can_manage_day, can_break, allowed_tabs, allowed_more, deny_actions) values (
  'accountant', 'المحاسب', 'يراجع الدفاتر ويعتمد ويعلّق — لا يبيع ولا يقبض ولا يُكوّد', false, false,
  '["more"]'::jsonb,
  '["accountantReview","dashboard","approvals","documents","bankFees","journal","generalLedger","trialBalance","fullStatements","anyStatement","financials","docCycle","reportsHub","reports","bankRecon","supplierLedger","officeLedger","salesHistory","purchases","customers","safeAudit","openingCompare","masterReport","codingReport","queryBuilder","search","taxReport","customerReport","suppliers","partners","fixedAssets","payroll","workday"]'::jsonb,
  '["openDay","closeDay","cashMove","expense","priceFix","sale","sell","sellCredit","discount","salesReturn","purchase","purchaseDeferred","addItem","addGoods","codeItems","issueOut","voidItem","stockAdjust","convertScrap","breakStones","sendScrap","assessScrap","approveScrap","buyScrap","categories","repair","taskir","settleSupplier","postJournal","backfill","fiscalClose","capitalChange","profitDistribution"]'::jsonb
) on conflict (id) do nothing;

-- المدير يرى الشاشات الجديدة؛ الموظّف والمساعد يريان شاشة العرض
update roles set allowed_more = (
  select jsonb_agg(distinct v) from jsonb_array_elements_text(
    allowed_more || '["accountantReview","dashboard","approvals","documents","bankFees","showcase","reportsHub"]'::jsonb) v
) where id = 'manager';
update roles set allowed_more = (
  select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["showcase"]'::jsonb) v
) where id in ('employee', 'assistant');

-- ⑧ ─────────────────────────────────────────────────────────────
insert into posting_rules (op_type, label, rule) values
  ('bank_fee_adjust', 'تسوية عمولة البنك — زيادة',
   '{"label": "تسوية عمولة البنك — زيادة", "cash": {"debit": "6500", "credit": "1120"}, "weight": null}'::jsonb),
  ('bank_fee_refund', 'تسوية عمولة البنك — نقص',
   '{"label": "تسوية عمولة البنك — نقص", "cash": {"debit": "1120", "credit": "6500"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

-- ⑨ تسويات عمولة البنك — مرّةً واحدة لكل شهر ─────────────────────
create table if not exists bank_fee_adjustments (
  id            uuid primary key default gen_random_uuid(),
  branch_id     uuid not null references branches(id),
  ref           text not null,
  period        text not null check (period ~ '^\d{4}-\d{2}$'),
  recorded      numeric(14,2) not null default 0,
  actual        numeric(14,2) not null default 0,
  diff          numeric(14,2) not null default 0,
  note          text,
  created_by    uuid references users(id),
  created_by_name text,
  business_day_id uuid references business_days(id),
  created_at    timestamptz not null default now(),
  unique (branch_id, period)
);
alter table bank_fee_adjustments enable row level security;
drop policy if exists branch_isolation_bank_fee_adjustments on bank_fee_adjustments;
create policy branch_isolation_bank_fee_adjustments on bank_fee_adjustments
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
