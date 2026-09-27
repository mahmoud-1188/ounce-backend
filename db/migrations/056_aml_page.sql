update roles set allowed_more = (select jsonb_agg(distinct v) from jsonb_array_elements_text(allowed_more || '["amlRegister"]'::jsonb) v) where id in ('manager', 'accountant');
