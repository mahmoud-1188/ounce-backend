/**
 * باقة المحل (migration 070): «بدون محاسبة» تُسقط الشاشات المحاسبية من صلاحيات كل مستخدم —
 * فتُرفض مساراتها بحرّاس الصفحات القائمة نفسها. القيود تبقى تُسجَّل في الخلفية.
 */
const PACKAGES = ["full", "no_accounting"];

const ACCOUNTING_PAGES = [
  "journal", "generalLedger", "trialBalance", "fullStatements", "financials", "ifrs", "combinedBook",
  "anyStatement", "queryBuilder", "docCycle", "accountantReview", "aiAccountant",
  "supplierLedger", "officeLedger", "bankRecon", "fixedAssets", "budgets",
];

// مسارات الإدارة المحاسبية: الميزان الموحّد · الزكاة · السنة المالية وإقفال الأشهر · دفاتر الفرع وقيوده
const HQ_ACCOUNTING_ROUTES = [
  /^\/api\/store\/(zakat|consolidated|fiscal)(\/|$)/,
  /^\/api\/store\/branches\/[^/]+\/(books|journal|adjustment|close-month)(\/|$)/,
];

const noAccounting = (pkg) => pkg === "no_accounting";
const applyPackage = (pages, pkg) => (noAccounting(pkg) && Array.isArray(pages) ? pages.filter((p) => !ACCOUNTING_PAGES.includes(p)) : pages);
const hqRouteBlocked = (pkg, url) => noAccounting(pkg) && HQ_ACCOUNTING_ROUTES.some((re) => re.test(String(url || "").split("?")[0]));

export { PACKAGES, ACCOUNTING_PAGES, applyPackage, hqRouteBlocked, noAccounting };
