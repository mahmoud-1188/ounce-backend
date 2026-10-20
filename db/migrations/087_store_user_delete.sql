-- حذف موظفٍ مركزي: حذفٌ منطقي يُبقي اسمه في السجلّ، ويحرّر بريده ليُعاد استعماله
alter table store_users add column if not exists deleted_at timestamptz;

-- حذف موظف الفرع: يخرج من كل القوائم ولا يدخل ولا يُعاد تفعيله، واسمه يبقى على عملياته.
-- (التعطيل غيره: active = false يُبقيه في القائمة ويُعاد بزرّ)
alter table users add column if not exists deleted_at timestamptz;
