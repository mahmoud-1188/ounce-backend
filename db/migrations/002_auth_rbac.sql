-- ============================================================
-- 002: Auth + RBAC layer
-- Adds the roles reference table, transcribed verbatim from
-- src/core/constants.js ROLES (scrap_buyer, scrap_officer, employee,
-- assistant, manager), and aligns the users table with the real
-- per-user permission-override semantics from AccessSettingsPage.jsx.
--
-- Run this after schema.sql + seed.sql, against the same database.
-- ============================================================

create table roles (
  id              text primary key,
  label           text not null,
  hint            text,
  can_manage_day  boolean not null default false,
  can_break       boolean not null default false,
  allowed_tabs    jsonb not null default '[]',
  allowed_more    jsonb not null default '[]',
  deny_actions    jsonb not null default '[]'
);

insert into roles (id, label, hint, can_manage_day, can_break, allowed_tabs, allowed_more, deny_actions) values
('scrap_buyer', 'مشتري كسر', 'يستلم الكسر ويشتريه فقط — لا يُكسّر ولا يُدخل مخزونًا', false, false,
  '[]'::jsonb, '["scrapIntake"]'::jsonb,
  '["breakStones","convertScrap","sendScrap","assessScrap","approveScrap","closeDay","openDay","addItem","sale","expense","cashMove","settleSupplier"]'::jsonb),
('scrap_officer', 'مسؤول الكسر', 'يستلم من المشتري ويُكسّر ويُثبّت الوزن — لا يبيع ولا يودع', false, true,
  '[]'::jsonb, '["scrapCustody","scrap"]'::jsonb,
  '["sale","expense","cashMove","settleSupplier","openDay","closeDay","convertScrap","addItem","refund","issueOut"]'::jsonb),
('employee', 'موظف', null, false, false,
  '["sales"]'::jsonb, '[]'::jsonb, '["openDay","closeDay"]'::jsonb),
('assistant', 'نائب المدير', null, true, true,
  '["sales","stocktake"]'::jsonb, '[]'::jsonb, '[]'::jsonb),
('manager', 'المدير', null, true, true,
  '["inventory","sales","cash","expenses","stocktake","more"]'::jsonb,
  '["addGoods","printing","printerSetup","salesHistory","sellerReports","price","reports","journal","trialBalance","search","bankRecon","supplierLedger","officeLedger","salesReturn","scrap","scrapIntake","scrapCustody","conversions","itemEdit","goldOut","categories","workday","customers","trustAccounts","reservations","safeAudit","integration","storeLink","backup","purchases","suppliers","taskirat","partners","access","taxReport","settings","financials","openingCompare","repairs","aiAssistant","navCustomize","openingBalance"]'::jsonb,
  '[]'::jsonb);

-- Replace the inline CHECK on users.role (only 3 of the 5 real roles) with
-- a foreign key to the roles table, so a new role never needs a schema change.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_fk foreign key (role) references roles(id);

-- allowed_tabs on the user row duplicated role-level data and the reference
-- app never actually overrides it per user (only allowed_pages is
-- overridden — see AccessSettingsPage.jsx currentAllowed()). Dropping it
-- avoids a column nobody writes to.
alter table users drop column if exists allowed_tabs;

-- Critical semantic fix: NULL must mean "no override — use my role's
-- defaults" (currentAllowed() in the frontend), which is a DIFFERENT
-- state from an explicit empty array ("this person can see nothing").
-- The original schema.sql default of '[]' collapsed that distinction.
alter table users alter column allowed_pages drop default;
alter table users alter column allowed_pages set default null;

alter table users add column if not exists ref text unique;
alter table users add column if not exists salary numeric(14,2) default 0;
alter table users add column if not exists can_use_ai boolean not null default false;

create index if not exists idx_users_branch_active on users(branch_id, active);
