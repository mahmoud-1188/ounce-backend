-- صفحات الوحدات الاختيارية في صلاحيات الأدوار (migrations 050–052)
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["modules", "reorder", "branchTransfers", "giftCards"]'::jsonb) v) where id = 'manager';
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["reorder", "branchTransfers", "giftCards"]'::jsonb) v) where id = 'assistant';
update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["giftCards"]'::jsonb) v) where id = 'employee';
