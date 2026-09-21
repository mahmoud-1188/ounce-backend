-- 027_hq_transactions.sql
--
-- "معاملات الإدارة" (hqDocs في المرجع) — طلبات/تحويلات حقيقية بين الفرع
-- والمركزي: طلب شراء، تسليم/استلام بضاعة، إرسال للتكويد، تسكير عبر
-- الإدارة، تحويل نقدي.
--
-- ⚠ نظير HQ_FLOWS/hqCreate/hqDecide في المرجع، لكن بنية نقلٍ مختلفة
-- جذريًّا: المرجع يُرمّز كل مستند في نصٍّ موقَّع (hqPack/hqSignature)
-- يُلصق يدويًّا وينتقل عبر واتساب بين نسخٍ منفصلة (راجع تعليق
-- 017_hq_reports.sql لنفس المبدأ في تقرير الإدارة) — لا معنى لهذا في
-- تطبيقنا الذي يخدم الفرع والمركزي من نفس القاعدة الحقيقية عبر API
-- حيّ. فالجدول هنا هو "المستند" نفسه، لا رمزًا يُفكّ لاحقًا، وسلامته
-- تُفرض بصلاحيات الجلسة الحقيقية (authenticate/authenticateStore) لا
-- بتوقيعٍ يُحسب في المتصفح.
--
-- ⚠ قرارٌ صريح (بعد سؤال المستخدم): من الأنواع الستة، اثنان فقط يُنشئان
-- أثرًا محاسبيًّا تلقائيًّا حتى في المرجع نفسه:
--   • goods_from_hq: عند "الاستلام" يدخل وزنٌ حقيقي لمخزون الفرع
--     (gold_ledger_entries) — يقابل handleReceiveShipment/postWeight
--     في المرجع بالضبط.
--   • purchase_request: لا يُرحّل بنفسه، بل "بوّابة موافقة" تُستهلك
--     (consumed_at/consumed_by) عند تنفيذ شراءٍ حقيقي لاحقًا عبر مسار
--     /purchases الموجود أصلًا — يقابل findPurchaseApproval في المرجع.
-- الأربعة الباقية (goods_to_hq, send_for_coding, taskir_to_hq,
-- cash_transfer) سجلّات workflow فقط (طلب/اعتماد/رفض/استلام) بلا أي
-- قيدٍ تلقائي — تمامًا كحالها في المرجع نفسه، الذي لم يُنفّذ لها ترحيلًا
-- قط رغم تعريفها في HQ_FLOWS.

create table hq_transactions (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references branches(id),

  flow text not null check (flow in (
    'purchase_request', 'goods_to_hq', 'goods_from_hq',
    'send_for_coding', 'taskir_to_hq', 'cash_transfer'
  )),

  -- ⚠ "من يبدأ" (dir في المرجع) عمدًا ليس عمودًا هنا: خمسة من الأنواع
  -- الستة يبدؤها الفرع دائمًا، وواحد فقط (goods_from_hq) تبدؤه الإدارة —
  -- علاقة ثابتة بالنوع نفسه، لا حقيقة إضافية عن هذا الصف بعينه. تخزينها
  -- كعمود منفصل يفتح احتمال تناقضها مع flow (صفٌّ بـflow='cash_transfer'
  -- وdir='hq' مثلًا) بلا أي فائدة — الثابت الحقيقي الوحيد مصدره الكود
  -- (HQ_FLOWS المقابل في الفرونت)، لا القاعدة.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'received')),

  weight       numeric(12,3),
  karat        smallint check (karat in (24,22,21,18,14)),
  fine_weight  numeric(12,3),
  pieces       integer check (pieces is null or pieces > 0),
  amount       numeric(14,2) check (amount is null or amount > 0),
  note         text,

  -- ⚠ فاعلان محتملان لكل حدث (مستخدم فرع بجلسة PIN، أو مستخدم مركزي
  -- بجلسة بريد/كلمة مرور) — نوعا هوية مختلفان جذريًّا في هذا التطبيق
  -- (راجع تعليق 022_store_users.sql)، فعمودان منفصلان لكل حدث بدل عمود
  -- واحد nullable الجدل حول أي جدول يُشير إليه.
  requested_by_user_id        uuid references users(id),
  requested_by_store_user_id  uuid references store_users(id),

  -- ⚠ القرار (اعتماد/رفض) من الإدارة دائمًا — الأنواع الخمسة التي يبدؤها
  -- الفرع فقط تمرّ بهذه الخطوة. goods_from_hq (تبدؤه الإدارة) لا "تعتمد"
  -- نفسها؛ ينتقل مباشرةً من pending إلى received حين يؤكّد الفرع الاستلام.
  decided_by_store_user_id  uuid references store_users(id),
  decided_at                timestamptz,
  decision_note             text,

  -- ⚠ "الاستلام" طرفه يختلف باختلاف اتجاه الحركة: من يستلم بضاعة/نقدًا
  -- خارجًا من الفرع هو الإدارة (goods_to_hq, taskir_to_hq, cash_transfer)،
  -- ومن يستلم بضاعةً قادمة من الإدارة هو الفرع (goods_from_hq،
  -- send_for_coding عند عودة القطع مُكوَّدة). عمودان منفصلان لنفس سبب
  -- requested_by أعلاه.
  received_by_user_id        uuid references users(id),
  received_by_store_user_id  uuid references store_users(id),
  received_at                timestamptz,

  -- ⚠ purchase_request فقط: الموافقة "تُستهلك" مرةً واحدة حين يُنفَّذ بها
  -- شراءٌ حقيقي عبر مسار /purchases — تمنع استخدام نفس الموافقة لشراءين.
  consumed_at          timestamptz,
  consumed_by_user_id   uuid references users(id),
  consumed_purchase_id  uuid references purchases(id),

  created_at timestamptz not null default now()
);

create index idx_hq_transactions_branch on hq_transactions(branch_id);
create index idx_hq_transactions_branch_status on hq_transactions(branch_id, status);

-- إتاحة صفحة "معاملات الإدارة" (hqDocs) في allowed_more للمدير — نفس
-- نمط 017_hq_reports.sql بالضبط (hqReports): لا حراسة خادم إضافية تلزم
-- أبعد من requirePage("hqDocs") في المسار، ولا تُطبَّق تلقائيًّا على
-- مستخدم بقائمة allowed_pages مخصَّصة (custom override).
update roles
   set allowed_more = allowed_more || '["hqDocs"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["hqDocs"]'::jsonb);

-- ⚠ عزل الفروع على مستوى القاعدة (RLS) لا يُطبَّق تلقائيًّا على جدولٍ
-- جديد — 021_rls_coverage.sql غطّى فقط الجداول الموجودة وقت كتابتها.
-- بلا هذه السياسة هنا، أي استعلامٍ عبر withBranch على hq_transactions
-- ينسى (أو يُخطئ لاحقًا) فلتر branch_id في الكود سيُسرّب معاملات فرعٍ
-- آخر — نفس فجوة migration 021 بالضبط، لجدولٍ لم يكن موجودًا حينها.
alter table hq_transactions enable row level security;
drop policy if exists branch_isolation_hq_transactions on hq_transactions;
create policy branch_isolation_hq_transactions on hq_transactions
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);
