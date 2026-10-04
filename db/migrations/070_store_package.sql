-- باقة اشتراك المحل (لوحة المنصة): «كاملة» أو «بدون محاسبة».
-- بدون محاسبة: تُخفى الشاشات المحاسبية في الفرع والإدارة ويرفضها الخادم (اليومية · الأستاذ · الميزان · القوائم ·
-- IFRS · الزكاة وإقفال الأشهر · المراجعة المحاسبية · المحاسب الذكي · كشوف الموردين والمكاتب · مطابقة البنك).
-- القيود تبقى تُسجَّل في الخلفية — فلا يتعطّل بيعٌ ولا إقفال يوم، وترقية الباقة تُظهر الدفاتر كاملةً من أوّل يوم.
-- الإقرار الضريبي والفاتورة الإلكترونية يبقيان في الباقتين.
alter table stores add column if not exists package text not null default 'full';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stores_package_check') then
    alter table stores add constraint stores_package_check check (package in ('full', 'no_accounting'));
  end if;
end $$;
