-- حذف موظفٍ مركزي: حذفٌ منطقي يُبقي اسمه في السجلّ، ويحرّر بريده ليُعاد استعماله
alter table store_users add column if not exists deleted_at timestamptz;
