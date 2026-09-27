-- الدفتر الثالث وشاشة IFRS (المرجع 5.2.0): صفحتا عرضٍ من الدفتر — للمدير والمحاسب
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["combinedBook", "ifrs"]'::jsonb) v)
 where id in ('manager', 'accountant');
