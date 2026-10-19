-- اعتماد جهاز الدفع على الفاتورة: رقم الاعتماد وآخر أربعة أرقام والشبكة والمرجع — ولا رقم بطاقةٍ غير آخر أربعة
alter table sales add column if not exists card_auth jsonb;
