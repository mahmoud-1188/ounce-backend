-- واجهة برمجية عامّة (v1) للأنظمة الأخرى — قراءةٌ فقط بمفتاحٍ تُصدره الإدارة. المفتاح يُحفظ مُجزَّأً ويظهر مرّةً عند إنشائه.
-- scope: 'ALL' لكل فروع المحل، أو رمز فرعٍ واحد.
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  label text not null default '',
  key_hash text not null unique,
  key_hint text not null,
  scope text not null default 'ALL',
  created_by uuid references store_users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists idx_api_keys_store on api_keys (store_id);
-- سجلّ الاستعمال للإضافة فقط
create table if not exists api_log (
  id bigserial primary key,
  key_id uuid not null references api_keys(id),
  path text not null,
  status smallint not null,
  rows integer not null default 0,
  at timestamptz not null default now()
);
create index if not exists idx_api_log_key on api_log (key_id, at desc);
