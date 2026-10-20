-- جرد الفروع من الإدارة (المرجع HqBranchStocktakePage): الإدارة تقفل مخزون الفرع للجرد وتعدّ رفّه بالمسح،
-- والنتيجة تصل الفرع بفروقها — «تُعتمد الفروق» أو «تقريرٌ فقط» — ويُفتح القفل عند تطبيقها.
alter table stocktake_locks add column if not exists locked_by_name text;
alter table stocktake_locks add column if not exists by_hq boolean not null default false;
alter table remote_stocktakes add column if not exists scan jsonb;
alter table remote_stocktakes add column if not exists apply_mode text not null default 'apply';
alter table remote_stocktakes add column if not exists unlock boolean not null default true;
alter table remote_stocktakes drop constraint if exists remote_stocktakes_apply_mode_check;
alter table remote_stocktakes add constraint remote_stocktakes_apply_mode_check check (apply_mode in ('apply', 'report'));
