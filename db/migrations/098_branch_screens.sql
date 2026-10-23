-- شاشات الفرع الأربع من المرجع (باب التقارير والبيع والرواتب): «الصافي بالوزن» و«كم ضاع في التصنيع؟»
-- و«ملف حماية الأجور» و«طلبات المتجر». تُمنح لكل دورٍ يملك الشاشة الأمّ — كما في ROLES بالواجهة.
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["netWeight","wastageReport"]'::jsonb) v)
 where allowed_more ? 'reportsHub';
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["wastageReport"]'::jsonb) v)
 where allowed_more ? 'workshop';
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["wps"]'::jsonb) v)
 where allowed_more ? 'payroll';
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["storeOrders"]'::jsonb) v)
 where allowed_more ? 'storeLink' or allowed_more ? 'reservations';
