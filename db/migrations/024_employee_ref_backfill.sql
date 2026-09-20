-- 024_employee_ref_backfill.sql
--
-- ⚠ users.ref موجودٌ في الجدول منذ migration 002 لكن لم يُنشئه أي كود
-- فعليًّا قبل الآن (راجع src/domain/branchUsers.js: generateUniqueEmployeeRef
-- — تُستدعى الآن فقط عند إنشاء موظفٍ جديد). كل موظفٍ موجودٍ بالفعل قبل
-- هذه الهجرة له ref = null، فيبقى بلا رمز دخول قصير حتى تُشغَّل هذه
-- الهجرة مرة واحدة على القاعدة.
--
-- 4 محارف من نفس أبجدية الكود بالضبط (بلا 0/O أو 1/I/L — تفاديًا لالتباس
-- يُنطق بصوتٍ عالٍ أو يُكتب يدويًّا)، بحلقة تتحقق من التفرّد الفعلي في
-- الجدول (ref فريدٌ على مستوى القاعدة كلها لا الفرع وحده) قبل كل تعيين.
do $$
declare
  alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  u record;
  candidate text;
  attempt int;
begin
  for u in select id from users where ref is null loop
    attempt := 0;
    loop
      candidate := '';
      for i in 1..4 loop
        candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      end loop;
      exit when not exists (select 1 from users where ref = candidate);
      attempt := attempt + 1;
      if attempt > 20 then
        raise exception 'تعذّر توليد رمز فريد لموظف % بعد % محاولة', u.id, attempt;
      end if;
    end loop;
    update users set ref = candidate where id = u.id;
  end loop;
end $$;
