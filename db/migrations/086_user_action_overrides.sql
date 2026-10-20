-- استثناءات الأفعال لكل شخص فوق دوره: action_grant يفتح فعلًا يمنعه الدور،
-- وaction_revoke يغلق فعلًا يسمح به. منع الإدارة المركزية يغلب الاستثناء دائمًا.
alter table users add column if not exists action_grant text[] not null default '{}';
alter table users add column if not exists action_revoke text[] not null default '{}';

-- سجلّ الصلاحيات يقبل استثناء الأفعال، وإلغاء الجهاز الذي كان يُرفض بالقيد فيفشل الإلغاء نفسه
alter table permission_log drop constraint if exists permission_log_kind_check;
alter table permission_log add constraint permission_log_kind_check
  check (kind in ('create','delete','role','pages','reset','ai','rename','enroll','pin','activate','actions','device_revoke'));
