-- تنبيهات الإدارة كما في المرجع (hqAlerts): سقف مصروفات الشهر لكل فرع تضعه الإدارة («هدف وسقف»)،
-- ويُنبَّه حين تتجاوزه مصروفات الفرع في شهرها. صفرٌ = بلا سقف.
alter table branches add column if not exists expense_cap numeric(14,2) not null default 0 check (expense_cap >= 0);
