-- حسابات مصروفٍ مخصّصة لكل متجر (المرجع 2026-10-12 هـ «chartEdit»): المدير يضيف حسابًا باسمه
-- («اشتراك النظام السحابي» · «صيانة المكيّفات»…) تحت المصروفات 6000، فيظهر باسمه في اليومية
-- والأستاذ وميزان المراجعة وكشف الحساب ومصفوفة مصروفات الفروع.
--
-- الشجرة مشتركة بين المتاجر (accounts.code مفتاحٌ واحد)، فالحساب المخصّص يحمل store_id،
-- ورمزه من سبع خانات يبدأ بـ69 من تسلسلٍ واحد — لا يتصادم رمزا متجرين ولا يقع على حسابٍ قياسي،
-- ويبقى تحت البادئة 6 التي تقرأ بها التقارير المصروفات.
alter table accounts add column if not exists store_id uuid references stores(id);
alter table accounts add column if not exists hidden boolean not null default false;
alter table accounts add column if not exists created_at timestamptz default now();
create sequence if not exists custom_expense_account_seq start 1;
create index if not exists accounts_store_idx on accounts(store_id) where store_id is not null;
