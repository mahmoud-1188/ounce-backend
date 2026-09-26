-- 044: إصلاحات الدفتر من مراجعة المرجع 5.2.0
--
-- ① النقد في الطريق بين الفروع على 1170 (كما في شجرة المرجع) — و1160 يعود
--    «البنك — الحساب الجاري». ما رُحّل على 1160 من تحويلات الإدارة يُنقل إلى 1170.
insert into accounts (code, name, parent_code, unit, nature, statement, is_group, pool, method) values
  ('1170', 'تحويلات نقدية بين الفروع — وسيط', '1100', 'currency', 'debit', 'balance', false, NULL, NULL)
on conflict (code) do nothing;
update journal_lines l set account_code = '1170'
  from journal_entries e
 where e.id = l.entry_id and l.account_code = '1160' and e.op_type in ('branch_cash_out', 'branch_cash_in');
update accounts set name = 'البنك — الحساب الجاري' where code = '1160';
update posting_rules set rule = '{"label": "تحويل نقد إلى فرع", "cash": {"debit": "1170", "credit": "1110"}, "weight": null}'::jsonb
 where op_type = 'branch_cash_out';
update posting_rules set rule = '{"label": "استلام نقد من الإدارة", "cash": {"debit": "1110", "credit": "1170"}, "weight": null}'::jsonb
 where op_type = 'branch_cash_in';

-- ② سلف الموظفين (2350) أصلٌ تحت «المدينون» (1300) برمزه القديم — كانت تُعرض التزامًا موجبًا.
update accounts set parent_code = '1300', nature = 'debit' where code = '2350';

-- ③ التحويل بين الصناديق (خزنة ↔ يومي ↔ عهدة) يُقيَّد: كان يحرّك النقد في الصناديق
--    بلا قيد، فيبقى 1130 ممتلئًا و1110 ناقصًا في الأستاذ بعد كل توريدٍ أو تمويل.
insert into posting_rules (op_type, label, rule) values
  ('pool_transfer', 'تحويل بين الصناديق',
   '{"label": "تحويل بين الصناديق", "cash": null, "note": "مدين حساب الصندوق الوجهة ودائن المصدر: 1110/1120 خزنة · 1130/1140 يومي · 1150 عهدة", "weight": null}'::jsonb)
on conflict (op_type) do nothing;

-- ④ القديم يُقيَّد مرّةً بتاريخه: كل حركة «خروجٍ إلى صندوقٍ آخر» بلا قيدٍ مرجعُه هي
do $$
declare
  r record;
  acc_from text;
  acc_to text;
  eid uuid;
begin
  for r in
    select t.* from cash_tx t
     where t.direction = 'out'
       and t.category in ('transfer_to_daily', 'transfer_to_safe', 'transfer_to_custody')
       and not exists (select 1 from journal_entries e where e.ref_table = 'cash_tx' and e.ref_id = t.id)
     order by t.created_at
  loop
    acc_from := case r.pool when 'safe' then (case r.method when 'network' then '1120' else '1110' end)
                            when 'daily' then (case r.method when 'network' then '1140' else '1130' end)
                            else '1150' end;
    acc_to := case r.category when 'transfer_to_safe' then (case r.method when 'network' then '1120' else '1110' end)
                              when 'transfer_to_daily' then (case r.method when 'network' then '1140' else '1130' end)
                              else '1150' end;
    continue when acc_from = acc_to or r.amount <= 0;
    insert into journal_entries (branch_id, business_day_id, op_type, ref_table, ref_id, description, created_by, created_at)
    values (r.branch_id, r.business_day_id, 'pool_transfer', 'cash_tx', r.id,
            coalesce(r.note, 'تحويل بين الصناديق') || ' — قيدٌ لاحق لحركةٍ قديمة', r.created_by, r.created_at)
    returning id into eid;
    insert into journal_lines (entry_id, account_code, side, amount) values
      (eid, acc_to, 'debit', r.amount), (eid, acc_from, 'credit', r.amount);
  end loop;
end $$;

-- ⑤ الحجز يُتمّ بفاتورته: العربون يُخصم منها ويُطفأ 2210
alter table reservations add column if not exists sale_id uuid references sales(id);
alter table reservations add column if not exists completed_at timestamptz;
alter table reservations add column if not exists deposit_used numeric(14,2) not null default 0;
alter table sales add column if not exists reservation_id uuid references reservations(id);
alter table sales add column if not exists deposit_applied numeric(14,2) not null default 0;
