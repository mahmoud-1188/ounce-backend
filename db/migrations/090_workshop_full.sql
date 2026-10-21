-- الورشة كاملة (المرجع): الورش موردون بعقدٍ (نسبة الهدر المسموح وأساسها)، والصرف بأكثر من وزنة،
-- والاستلام قطعةً قطعة تُكوَّد مباشرةً في المخزون، والبرادة تدخل صندوق الكسر، والأجور تُستحقّ عند الإقفال،
-- والهدر فوق المسموح مطالبةٌ على الورشة («لدى الورش» 1250) تُسوّى خصمًا من أجورها أو ذهبًا مردودًا أو خسارةً أو إبقاءً باعتماد.
alter table suppliers add column if not exists workshop boolean not null default false;
alter table suppliers add column if not exists workshop_terms jsonb;

alter table workshop_jobs add column if not exists workshop_id uuid references suppliers(id);
alter table workshop_jobs add column if not exists issues jsonb not null default '[]'::jsonb;
alter table workshop_jobs add column if not exists receipts jsonb not null default '[]'::jsonb;
alter table workshop_jobs add column if not exists fees jsonb not null default '{}'::jsonb;
alter table workshop_jobs add column if not exists settlement jsonb;
alter table workshop_jobs add column if not exists received_at timestamptz;
alter table workshop_jobs drop constraint if exists workshop_jobs_status_check;
alter table workshop_jobs add constraint workshop_jobs_status_check check (status in ('open', 'received', 'pending', 'closed'));

alter table scrap_items drop constraint if exists scrap_items_source_check;
alter table scrap_items add constraint scrap_items_source_check check (source in ('buy', 'trade_in', 'workshop'));

insert into posting_rules (op_type, label, rule) values
  ('workshop_fees', 'أجور الورشة المستحقة', '{"cash": {"debit": "5210", "credit": "2120"}, "weight": null}'),
  ('workshop_fees_paid', 'سداد أجور الورشة', '{"cash": {"debit": "2120", "credit": "1110"}, "weight": null}'),
  ('workshop_claim_settle', 'تسوية مطالبة الورشة', '{"cash": {"debit": "2120", "credit": "1220"}, "weight": {"from": "1250", "to": null}}')
on conflict (op_type) do nothing;

-- الأوامر القديمة: وزنة صرفها الوحيدة تُنقل إلى قائمة الوزنات
update workshop_jobs set issues = jsonb_build_array(jsonb_build_object('weight', issued_weight, 'evidence', evidence->'issued', 'at', created_at))
 where issues = '[]'::jsonb;
