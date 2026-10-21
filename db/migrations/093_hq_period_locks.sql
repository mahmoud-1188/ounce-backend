-- قفل الفترات من الإدارة لكل الفروع: قفلٌ بجانب قفل الفرع، والنافذ أبعدُهما — فالفرع لا يفكّ قفل الإدارة وحده
alter table branch_settings add column if not exists hq_lock_all date;
alter table branch_settings add column if not exists hq_lock_posted date;
