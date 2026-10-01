-- رقابة البيع المشتركة وصحّة الدفاتر (المرجع: ت١ «صحة الدفاتر» — 2026-09-30).
--
-- ① نوعا اعتمادٍ جديدان على كل مسارات البيع (الفاتورة · البيع بالوزن · جزء الطقم):
--    «أرضية السعر» — بيعٌ تحت تكلفة القطعة أو تحت قيمة ذهبها الصافي بسعر اليوم،
--    و«حدّ الآجل» — آجلٌ يتجاوز حدّ العميل أو لعميلٍ عليه فاتورةٌ آجلة متأخّرة.
--    الحدّ صفر: كل حالةٍ منهما تحتاج اعتمادًا (المدير يعتمد نفسه ويُسجَّل).
-- ② حدّ الآجل لكل عميل، وافتراضيٌّ وأيام التأخّر في إعدادات الفرع (صفر = بلا فحص).
-- ③ العربون المحتجز عند إلغاء الحجز بلا ردّ يُصادَر إيرادًا (4350) — كان يبقى التزامًا في 2210 إلى الأبد.

insert into approval_rules (id, label, threshold, approver_role) values
  ('price_floor', 'بيعٌ تحت أرضية السعر', 0, 'manager'),
  ('credit_limit', 'آجلٌ فوق حدّ العميل', 0, 'manager')
on conflict (id) do nothing;

alter table customers add column if not exists credit_limit numeric(14,2);
alter table branch_settings add column if not exists credit_limit_default numeric(14,2) not null default 0;
alter table branch_settings add column if not exists credit_overdue_days int not null default 0;

insert into accounts (code, name, parent_code, unit, nature, statement, is_group) values
  ('4350', 'عرابين مصادَرة', '4300', 'currency', 'credit', 'income', false)
on conflict (code) do nothing;

insert into posting_rules (op_type, label, rule) values
  ('deposit_forfeit', 'مصادرة عربون حجزٍ ملغى',
   '{"label": "مصادرة عربون حجزٍ ملغى", "cash": {"debit": "2210", "credit": "4350"}, "weight": null}'::jsonb)
on conflict (op_type) do nothing;

alter table reservations add column if not exists forfeited numeric(14,2) not null default 0;

-- ④ جرد الخزنة يُسوّي فرق الذهب بقيدٍ ماليّ مع رجله الوزنية، وفرقٌ فوق 500 يمرّ ببوّابة الاعتماد
--    (المدير يعتمد نفسه ويُسجَّل، أو الإدارة إن جعلته لها).
insert into approval_rules (id, label, threshold, approver_role) values
  ('safe_audit', 'فرق جرد الخزنة', 500, 'manager')
on conflict (id) do nothing;

-- ⑤ إنهاء اليوم فعلٌ واحد (المرجع ت٢): فرق عدّ الصندوق فوق 100 يعتمده غير من عدّ (والمدير الذي عدّ يُرفع فرقه للإدارة).
insert into approval_rules (id, label, threshold, approver_role) values
  ('count_variance', 'فرق عدّ الصندوق', 100, 'manager')
on conflict (id) do nothing;

-- ⑥ إصلاح: المراجع تُرقَّم لكل فرع (SALE-000001 · DAY-001 …) لكن القيد كان «فريدًا في كل الفروع»،
--    فأوّل فاتورةٍ أو يومٍ في الفرع الثاني يُرفض بخطأ خادم. الفريد الآن داخل الفرع.
--    (التحويل بين الفروع ورموز الوحدات والمستخدمون والفروع تبقى فريدةً عامّةً — تُقرأ عبر الفروع.)
do $$
declare t text;
begin
  foreach t in array array['business_days','customers','daily_custody','expenses','fixed_assets','gold_issues','items',
                           'purchases','receipts','repairs','reservations','returns','safe_audits','sales',
                           'scrap_items','scrap_requests','suppliers','taskir_offices']
  loop
    execute format('alter table %I drop constraint if exists %I', t, t || '_ref_key');
    if not exists (select 1 from pg_constraint where conname = t || '_branch_ref_key') then
      execute format('alter table %I add constraint %I unique (branch_id, ref)', t, t || '_branch_ref_key');
    end if;
  end loop;
end $$;

-- ⑦ مهلة الطلب (المرجع ت٢): المعلّق بعد 72 ساعة «انتهت مهلته» — حالةٌ جديدة.
alter table approvals drop constraint if exists approvals_status_check;
alter table approvals add constraint approvals_status_check
  check (status in ('pending', 'approved', 'rejected', 'executed', 'cancelled', 'expired'));

-- ⑧ فواتير معلّقة وعروض أسعار (المرجع D — SaleDraftsPage): فاتورةٌ تُحفظ قبل إتمامها وتُستأنف من أي جهاز،
--    أو عرض سعرٍ يُطبع للعميل بصلاحيته. لا قيد ولا حركة مخزون — الحركة كلّها عند إتمامها فاتورةً.
create table if not exists sale_drafts (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  ref          text not null,
  kind         text not null check (kind in ('held', 'quote')),
  customer_id  uuid references customers(id),
  customer_name text,
  payload      jsonb not null,
  total        numeric(14,2) not null default 0,
  valid_until  date,
  status       text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  sale_id      uuid,
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  unique (branch_id, ref)
);
alter table sale_drafts enable row level security;
drop policy if exists branch_isolation_sale_drafts on sale_drafts;
create policy branch_isolation_sale_drafts on sale_drafts
  using (branch_id = current_setting('app.current_branch_id', true)::uuid);

-- ⑨ تفضيلات البيع في إعدادات الفرع (المرجع: إعدادات البيع): ورقة ما بعد البيع (مطفأة افتراضيًّا)،
--    البيع أثناء الجرد (مطفأ — ما بِيع منذ بدء القفل يُطابَق مبيعًا عند تطبيق الجرد)، وصلاحية عرض السعر بالأيام.
alter table branch_settings add column if not exists sale_prefs jsonb not null default '{}'::jsonb;

-- ⑩ الحجز (المرجع: ReservationsPage): «محجوز حتى» تاريخٌ يُذكّر بانتهاء المهلة، وخطّة تقسيطٍ اختيارية
--    (جدول دفعاتٍ متساوية بعد العربون) تُسدَّد بدفعاتٍ على الحجز نفسه — كلّ دفعةٍ عربونٌ إضافيّ (2210).
alter table reservations add column if not exists hold_until date;
alter table reservations add column if not exists plan jsonb;
