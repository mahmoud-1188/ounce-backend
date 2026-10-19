-- الفاتورة الضريبية الكاملة (بين منشأتين): الرقم الضريبي للمشتري وعنوانه
alter table customers add column if not exists vat_number text;
alter table customers add column if not exists address text;
