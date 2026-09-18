-- 021_rls_coverage.sql
--
-- ⚠ إصلاح فجوة عزل حقيقية اكتُشفت أثناء مراجعة العزل بين المتاجر (تمهيدًا
-- لتعدّد المستأجرين — migration 020_stores_multi_tenant.sql): عزل الفروع
-- على مستوى القاعدة نفسها (RLS) كان مطبَّقًا فعليًا على عدد محدود من
-- الجداول (items, sales, cash_tx, gold_ledger_entries, journal_entries،
-- وبضعة جداول أخرى — راجع pg_policies قبل هذه الهجرة)، وكل الباقي كان
-- يعتمد فقط على أن كل مسار في الكود يكتب `where branch_id = $1` بيده —
-- بلا شبكة أمان من القاعدة تمنع استعلامًا نسي ذلك الفلتر.
--
-- ⚠ لماذا كان هذا مقبولًا قبل الآن ومصيريًّا الآن: قبل stores، نسيان فلتر
-- في الكود كان يُسرّب فرعًا داخل *نفس* المتجر (خطأ عملي، لا خرقًا). بعد
-- تعدّد المتاجر، نفس النسيان يُسرّب بيانات متجرٍ كاملةً لمتجرٍ آخر مختلف
-- تمامًا — وهذا اختراق بيانات حقيقي بين عميلين مشتركين مستقلّين.
--
-- ⚠ هذه الهجرة تضيف الشبكة الناقصة فقط — لا تُغيّر أي استعلام تطبيقي
-- موجود ولا تُبطئ شيئًا عمليًّا (RLS هنا مطابقة عمود/معاملة فرعية بسيطة،
-- وكل استعلامات الكتابة أصلًا تمرّ عبر withBranch التي تضبط
-- app.current_branch_id لكل معاملة، فهذه السياسات ستُطابق بلا أي تعديل
-- في src/*).
--
-- ⚠⚠ idempotent عمدًا (drop policy if exists قبل كل create): محاولة
-- تشغيل سابقة لهذا الملف توقّفت في المنتصف (تعارض policy موجود بالفعل)،
-- فأُعيدت كتابته ليكون آمن التكرار الكامل — تشغيله أي عدد من المرات
-- ينتج نفس الحالة النهائية بلا أي خطأ، سواء كانت هذه أول محاولة أو
-- استكمال محاولة متوقفة.

-- ═══ ① جداول تحمل branch_id مباشرة — نفس نمط policies الموجودة أصلًا ═══
do $$
declare
  t text;
  tables text[] := array[
    'users', 'hq_permissions', 'business_days', 'stocktake_locks', 'categories',
    'lots', 'customers', 'returns', 'receipts', 'reservations', 'suppliers',
    'scrap_items', 'scrap_custody', 'scrap_requests', 'scrap_surplus', 'repairs',
    'weight_adjustments', 'safe_gold_tx', 'taskir_offices', 'taskir_entries',
    'taskir_office_tx', 'safe_audits', 'trust_accounts', 'partners',
    'fixed_assets', 'cost_centers', 'budgets', 'payroll_runs', 'attendance',
    'leave_requests', 'commissions', 'approvals', 'audit_log',
    'opening_balances', 'fiscal_closures', 'period_close', 'expense_names',
    'expenses', 'store_links', 'store_orders', 'integrations', 'ext_invoices',
    'webhooks', 'printers'
  ];
begin
  foreach t in array tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', 'branch_isolation_' || t, t);
    execute format(
      'create policy branch_isolation_%1$s on %1$I
         using (branch_id = current_setting(''app.current_branch_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

-- ═══ ② جداول تفصيلية بلا branch_id خاص بها — العزل عبر ربط بالأب ═══
--
-- ⚠ هذه لا branch_id فيها أصلًا (تصميمٌ صحيح: التكرار كان سيُخاطر بتفصيل
-- سطرٍ يخالف رأسه)، فسياستها تتحقق عبر الجدول الأب الذي يحمل branch_id
-- فعليًا — نفس مبدأ RLS، منطق مطابقة مختلف بالضرورة لا استثناء منه.

alter table journal_lines enable row level security;
drop policy if exists branch_isolation_journal_lines on journal_lines;
create policy branch_isolation_journal_lines on journal_lines
  using (exists (
    select 1 from journal_entries e
     where e.id = journal_lines.entry_id
       and e.branch_id = current_setting('app.current_branch_id', true)::uuid
  ));

alter table sale_lines enable row level security;
drop policy if exists branch_isolation_sale_lines on sale_lines;
create policy branch_isolation_sale_lines on sale_lines
  using (exists (
    select 1 from sales s
     where s.id = sale_lines.sale_id
       and s.branch_id = current_setting('app.current_branch_id', true)::uuid
  ));

alter table item_units enable row level security;
drop policy if exists branch_isolation_item_units on item_units;
create policy branch_isolation_item_units on item_units
  using (exists (
    select 1 from items i
     where i.id = item_units.item_id
       and i.branch_id = current_setting('app.current_branch_id', true)::uuid
  ));

alter table partner_tx enable row level security;
drop policy if exists branch_isolation_partner_tx on partner_tx;
create policy branch_isolation_partner_tx on partner_tx
  using (exists (
    select 1 from partners p
     where p.id = partner_tx.partner_id
       and p.branch_id = current_setting('app.current_branch_id', true)::uuid
  ));

alter table payroll_lines enable row level security;
drop policy if exists branch_isolation_payroll_lines on payroll_lines;
create policy branch_isolation_payroll_lines on payroll_lines
  using (exists (
    select 1 from payroll_runs r
     where r.id = payroll_lines.payroll_run_id
       and r.branch_id = current_setting('app.current_branch_id', true)::uuid
  ));

-- ⚠⚠ users محتاجٌ ملاحظة صريحة: تسجيل الدخول (auth.routes.js) يقرأ هذا
-- الجدول عبر withoutBranch عمدًا (لا يُعرف branchId الصحيح إلا بعد
-- إيجاد المستخدم بمعرّفه) — وwithoutBranch لا يضبط app.current_branch_id
-- إطلاقًا، فـcurrent_setting هناك يُرجع فارغًا لا قيمة فرعٍ خاطئة. هذا
-- يعني RLS الجديدة أعلاه على users لا تُفعَّل نهائيًّا لتلك الاستعلامات
-- المحدَّدة أصلًا بـid كاملٍ (id = $1 and branch_id = $2 في نفس الشرط) —
-- سلوكها لا يتغيّر، فهي مطابقةٌ يدويةٌ صريحة أصلًا لا اعتمادًا ضمنيًّا على
-- RLS. الحماية الجديدة تفيد فقط أي استعلامٍ *آخر* يُستدعى عبر withBranch
-- ونسي فلتر branch_id بيده.
