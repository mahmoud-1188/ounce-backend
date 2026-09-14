-- 018_price_fix.sql
--
-- يفعّل التثبيت — ذهب ↔ نقد (price fix): تحويل مباشر بين وزن ذهب الخزنة
-- (1220) ونقد الخزنة (1110/1120) بسعر يختاره المستخدم لحظة التثبيت —
-- "الجسر الوحيد بين الدفترين" بتعبير المرجع (PriceFixPage.js/computeFix.js/
-- FIX_KINDS)، إذ لا شيء آخر في التطبيق يحوّل وزنًا إلى نقد أو العكس مباشرة.
--
-- ⚠ خلافًا لكل الميزات السابقة (015/016/017): posting_rules.price_fix_sell/
-- price_fix_buy غير موجودين إطلاقًا في seed.sql — لا سقالة ميتة هنا، بل
-- قاعدة جديدة كليًا. سبب عدم وجودهما أصلًا: journal_entries.op_type يحمل
-- foreign key حقيقيًا إلى posting_rules(op_type) (خلاف gold_ledger_entries.
-- op_type النصي الحر) — فأي عملية جديدة تُرحَّل عبر postJournalEntry تحتاج
-- سطرًا هنا أولًا، ولو لم تُستخدَم getPostingRule فعليًا في المسار (نفس
-- نمط كل route آخر في هذا الباك إند: قراءة توثيقية لا استدعاء برمجي حقيقي).
--
-- ── جدول جديد: price_fixes ──
--
-- لا مقابل له في schema.sql أصلًا (خلاف كل جدول لمسته الميزات الثلاث
-- السابقة) — المرجع يخزّن كل تثبيت محليًا فقط (PRICE_FIX_KEY)، فلا سجل
-- قاعدة بيانات مرجعي لننقل شكله عنه حرفيًا؛ الأعمدة هنا مُشتقّة من حقول
-- rec في handlePriceFix المرجعي (kind/karat/weight_24k/cash_amount/
-- price24/note) + ما يلزم أي جدول عملية آخر في هذا الباك إند (branch_id/
-- business_day_id/ref/created_by).
create table if not exists price_fixes (
  id               uuid primary key default gen_random_uuid(),
  branch_id        uuid not null references branches(id),
  business_day_id  uuid references business_days(id),
  ref              text not null,
  kind             text not null check (kind in ('gold_to_cash','cash_to_gold')),
  karat            smallint not null check (karat in (24,22,21,18,14)),
  weight_24k       numeric(12,3) not null check (weight_24k > 0),
  cash_amount      numeric(14,2) not null check (cash_amount > 0),
  price24          numeric(14,4) not null check (price24 > 0),
  funding_source   text not null check (funding_source in ('safe_cash','safe_network')),
  note             text,
  created_by       uuid references users(id),
  created_at       timestamptz default now()
);

alter table price_fixes enable row level security;

create policy branch_isolation_price_fixes on price_fixes
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ⚠ قرار محاسبي حقيقي (بعد سؤالك صراحةً): المرجع نفسه لم يُكمل هذا القيد
-- قط — POSTING_RULES.price_fix_sell/buy في chart.js المرجعي يرحّلان المبلغ
-- كاملًا لحسابين مؤقتين غير موجودين في شجرتنا أصلًا (4180/5180) بتعليق
-- صريح "الفرق عن التكلفة يُفصل لاحقًا" — أي لا ربح/خسارة حقيقيين محتسَبين
-- هناك، ولا توجد أصلًا تكلفة متتبَّعة لذهب الخزنة (1220) في قاعدتنا (ولا
-- في المرجع) لحساب ربح/خسارة حقيقيين مقابلها. البديلان كانا: (أ) مقاصة
-- بسيطة بين 1220 ونقد الخزنة مباشرة بلا حساب ربح/خسارة، أو (ب) بناء نظام
-- تتبّع تكلفة متوسطة لذهب الخزنة من الصفر ليُستخدَم حساب 4210/4220
-- الموجودين أصلًا في شجرتنا ("ربح رأسمالي محقق من السعر" — من السوق لا من
-- التجارة). اخترت (أ): مقاصة مباشرة 1220 ↔ 1110/1120 بلا حساب فرق — أقرب
-- لمحاسبة نقدية بسيطة وأسرع تنفيذًا، ومتّسقة مع أن المرجع نفسه لم يكمّل
-- البديل (ب) قط رغم إعلانه عن نيته. حساب 4210/4220 يبقى غير مُستخدَم من
-- هذه الميزة تحديدًا — أي ميزة تتبّع تكلفة مستقبلية لذهب الخزنة يمكنها
-- استخدامه حينها بحساب فرق حقيقي، لا مقاصة بلا فرق كما هنا.
insert into posting_rules (op_type, label, rule)
values
  ('price_fix_sell', 'تثبيت ذهب → نقد',
   '{"label": "تثبيت ذهب → نقد", "cash": null, "weight": {"from": "1220", "to": null}}'::jsonb),
  ('price_fix_buy', 'تثبيت نقد → ذهب',
   '{"label": "تثبيت نقد → ذهب", "cash": null, "weight": {"from": null, "to": "1220"}}'::jsonb)
on conflict (op_type) do nothing;

-- إتاحة صفحة "التثبيت" في allowed_more للمدير — الحارس الخادمي الحقيقي هو
-- requireManager على مسار الكتابة نفسه (priceFix.routes.js)، تمامًا كنمط
-- fixedAssets/payroll: هذا السطر فقط يمنح ظهور الصفحة افتراضيًا في القائمة
-- (ولا يُطبَّق تلقائيًّا على مستخدم بقائمة allowed_pages مخصَّصة).
update roles
   set allowed_more = allowed_more || '["priceFix"]'::jsonb
 where id = 'manager'
   and not (allowed_more @> '["priceFix"]'::jsonb);
