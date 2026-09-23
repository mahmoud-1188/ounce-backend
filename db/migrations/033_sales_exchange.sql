-- 033_sales_exchange.sql
--
-- الاستبدال (POST /sales/:id/exchange): مرتجعٌ وفاتورةٌ جديدة في معاملةٍ
-- واحدة، والدرج يتحرّك بالفرق وحده. المستندان مرتبطان:
--
--   • sales.exchange_of_sale_id  — الفاتورة الجديدة ← الفاتورة الأصل.
--   • returns.exchange_sale_id   — المرتجع ← الفاتورة الجديدة.
--   • returns.exchange_settle    — cash | card | credit (طريقة تسوية الفرق).
--   • returns.exchange_diff      — الجديدة − المرتجع (موجب: دفع العميل).
--
-- آمنة للتشغيل أكثر من مرة.

alter table sales add column if not exists exchange_of_sale_id uuid references sales(id);

alter table returns add column if not exists exchange_sale_id uuid references sales(id);
alter table returns add column if not exists exchange_settle text;
alter table returns add column if not exists exchange_diff numeric(14,2);

alter table returns drop constraint if exists returns_exchange_settle_check;
alter table returns add constraint returns_exchange_settle_check
  check (exchange_settle is null or exchange_settle in ('cash','card','credit'));

create index if not exists sales_exchange_of_idx on sales(exchange_of_sale_id) where exchange_of_sale_id is not null;
create index if not exists returns_exchange_sale_idx on returns(exchange_sale_id) where exchange_sale_id is not null;
