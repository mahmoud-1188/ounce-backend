-- Migration 006 — عمليات الخزنة المستقلة (تحويلات نقد بين الصناديق، تمويل
-- عهدة الكسر، حركة ذهب يدوية في الخزنة، جرد الخزنة) + إخراج بضاعة من النظام
-- (Issue Out).
--
-- ⚠ عكس migration 004/005: هنا لا حاجة لأي تعديل على cash_tx — الجدول
-- مصمَّم أصلًا (منذ Schema الأولي) بعمود `pool` (safe/daily/custody) يمثّل
-- الصناديق الثلاثة في جدول واحد، بعكس المرجع الذي يحتفظ بثلاث مصفوفات
-- منفصلة (cashTx/safeTx/scrapCustodyTx) ويكتب لكل واحدة يدويًا عند كل
-- تحويل. التحويل بين صندوقين هنا هو ببساطة سطرا cash_tx (خروج من صندوق،
-- دخول لآخر) بنفس منطق المرجع لكن على جدول موحّد.

-- ============================================================
-- 1. safe_gold_tx — إضافة kind (خام/مشغول)، office_id (لوجهة "تسكير")،
-- ومرجع تتبع عام لمصدر الحركة (يدوي/جرد/تسوية).
-- ============================================================

alter table safe_gold_tx add column if not exists kind text not null default 'raw'
  check (kind in ('raw','crafted'));
alter table safe_gold_tx add column if not exists office_id uuid references taskir_offices(id);
alter table safe_gold_tx add column if not exists ref_table text;
alter table safe_gold_tx add column if not exists ref_id uuid;

-- ============================================================
-- 2. safe_audits — جرد الخزنة (نقد + شبكة + ذهب لكل عيار).
-- ⚠ إصلاح حقيقي بعد سؤالك: في المرجع، SafeAuditPage تقرأ
-- safeBalance.byKarat/.fineWeight لكن الكائن الممرَّر لها (safeBalance)
-- كائن نقد فقط ({cash,network,total}) — فحقول جرد الذهب لكل عيار لا تظهر
-- إطلاقًا، ومسار جرد الذهب معطَّل بالكامل في المرجع رغم وجود كوده. هنا
-- نبنيه صحيحًا: المصدر الصحيح لـ"المسجَّل حاليًا" هو ما يعادل
-- safeGoldBalance.byKarat (يُحسب من safe_gold_tx نفسه)، لا safeBalance.
-- ============================================================

alter table safe_audits add column if not exists ref text;
alter table safe_audits add column if not exists business_day_id uuid references business_days(id);
alter table safe_audits add column if not exists counted_network numeric(14,2);
alter table safe_audits add column if not exists diff_network numeric(14,2);
-- سطر واحد لكل عيار مُعدود فعليًا: [{karat, counted, shown, variance}]
-- (نفس أسلوب scrap_requests.payload/posting_rules.rule).
alter table safe_audits add column if not exists gold_lines jsonb;
alter table safe_audits add column if not exists note text;
alter table safe_audits add constraint safe_audits_ref_key unique (ref);

-- ============================================================
-- 3. item_units — دعم "إخراج من النظام" (Issue Out) كحالة مستقلة عن
-- "مباع" (sold) — قطعة تالفة/مفقودة/هدية/محوَّلة لفرع آخر/مُذابة لم
-- تُبَع، لكنها لم تعد ضمن المخزون القابل للبيع أيضًا.
-- ============================================================

alter table item_units add column if not exists issued boolean not null default false;
alter table item_units add column if not exists issued_at timestamptz;
alter table item_units add column if not exists issued_by uuid references users(id);
alter table item_units add column if not exists issue_id uuid;

create index if not exists idx_item_units_available
  on item_units(item_id) where sold = false and issued = false;

-- ============================================================
-- 4. gold_issues — رأس عملية إخراج بضاعة (سبب واحد، دفعة وحدات).
-- نفس فلسفة scrap_requests: أعمدة مُهيكَلة لكل ما يُستعلَم عنه تقريريًا،
-- وpayload/lines JSONB لتفاصيل الوحدات (لا نحتاج جدول سطور منفصل).
-- ============================================================

create table if not exists gold_issues (
  id                uuid primary key default gen_random_uuid(),
  branch_id         uuid not null references branches(id),
  ref               text unique not null,
  business_day_id   uuid references business_days(id),
  reason_id         text not null,
  account           text not null,
  lines             jsonb not null,   -- [{itemUnitId, code, itemId, karat, weight}]
  total_weight      numeric(12,3) not null,
  total_fine_weight numeric(12,3) not null,
  note              text,
  created_by        uuid references users(id),
  created_at        timestamptz default now()
);

alter table item_units add constraint item_units_issue_id_fkey
  foreign key (issue_id) references gold_issues(id);

alter table gold_issues enable row level security;
create policy branch_isolation_gold_issues on gold_issues
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ============================================================
-- 5. posting_rules — سطر جديد لـ"gold_issue_out".
-- ⚠ اكتُشف فعليًا أثناء تشغيل اختبار حقيقي (لا نظريًا): journal_entries.op_type
-- عليه قيد مفتاح خارجي صريح إلى posting_rules(op_type) — أي محاولة
-- postJournalEntry بـop_type غير موجود في هذا الجدول تُرفَض فورًا
-- (23503 foreign key violation)، بعكس gold_ledger_entries.op_type الذي
-- نص حر بلا قيد مماثل (لهذا نجحت scrap_break_gain/loss هناك بلا مشكلة —
-- لم تُستخدَم إطلاقًا في postJournalEntry، فقط في gold_ledger_entries).
-- "gold_issue_out" جديد كليًا (لا "gold_out" الخاطئ في المرجع ولا
-- "safe_gold_out" الموجود أصلًا)، وحسابه المدين متغيّر حسب سبب الإخراج
-- (ISSUE_REASONS في inventory.routes.js) لا ثابت كبقية القواعد — فالحقل
-- `rule` هنا توثيقي لا يُستهلَك برمجيًا (الحساب الفعلي يُبنى في الكود).
insert into posting_rules (op_type, label, rule) values
  ('gold_issue_out', 'إخراج بضاعة من النظام',
   '{"label": "إخراج بضاعة من النظام", "cash": null, "weight": {"from": "1210", "to": null},
     "note": "حساب المدين متغيّر حسب سبب الإخراج — راجع ISSUE_REASONS في inventory.routes.js"}'::jsonb)
on conflict (op_type) do nothing;
