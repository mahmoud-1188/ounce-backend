// صلاحيات شاشات الموظف المركزي تُفرض على الخادم لا في الواجهة وحدها:
// كل مسار /store مربوطٌ بالشاشات التي تستدعيه، والموظف المقيَّد (allowed_pages مصفوفة)
// لا يصل إلا لما تفتحه شاشاته. صلاحية التكويد (can_send_coding) تفتح مسارات التكويد وحدها.
// المالك أو allowed_pages = null بلا قيد. المسار غير المعروف مرفوضٌ للمقيَّد (الأمان أولًا).

const ANY = "*"; // أيّ شاشةٍ مسموحة تكفي — كقائمة أسماء الفروع في القوائم المنسدلة

// [method|null, regex, pages[], coding?]
const RULES = [
  [null, /^\/store\/coding-queue$/, [], true],
  [null, /^\/store\/branches\/[^/]+\/lots\/[^/]+\/(items|uncode|ship)$/, [], true],
  [null, /^\/store\/branches\/[^/]+\/remnants(\/[^/]+\/code)?$/, ["branches"], true],
  [null, /^\/store\/branches\/[^/]+\/coding-model$/, ["branches"], true],
  [null, /^\/store\/branches\/[^/]+\/hq-purchase$/, ["branches", "hqDocs"]],
  ["GET", /^\/store\/branches$/, [ANY]],
  [null, /^\/store\/branches(\/.*)?$/, ["branches"]],
  [null, /^\/store\/report$/, ["report", "home", "branches"]],
  [null, /^\/store\/analytics$/, ["analytics"]],
  [null, /^\/store\/alerts$/, ["home"]],
  [null, /^\/store\/approvals(\/.*)?$/, ["approvals", "home"]],
  [null, /^\/store\/approval-routing$/, ["approvals"]],
  ["GET", /^\/store\/price-policy$/, ["control", "home"]],
  [null, /^\/store\/price-policy$/, ["control"]],
  [null, /^\/store\/(notices(\/.*)?|targets)$/, ["control"]],
  [null, /^\/store\/(cash-transit|goods-transit)$/, ["hqDocs"]],
  [null, /^\/store\/hq-transactions\/capital-draw$/, ["branches", "hqDocs"]],
  ["GET", /^\/store\/hq-transactions$/, ["branches", "hqDocs"]],
  [null, /^\/store\/hq-transactions(\/.*)?$/, ["hqDocs"]],
  [null, /^\/store\/consolidated$/, ["consolidated"]],
  [null, /^\/store\/accounts$/, ["consolidated", "branches"]],
  [null, /^\/store\/bank-fees(\/.*)?$/, ["expenses", "branches"]],
  [null, /^\/store\/expenses-matrix$/, ["expenses"]],
  [null, /^\/store\/net-weight$/, ["netWeight"]],
  [null, /^\/store\/zakat$/, ["zakat"]],
  [null, /^\/store\/fiscal$/, ["fiscal"]],
  [null, /^\/store\/hq-policy$/, ["policy"]],
  [null, /^\/store\/ops-log$/, ["opsLog"]],
  [null, /^\/store\/client-errors(\/.*)?$/, ["clientErrors"]],
  [null, /^\/store\/api-keys(\/.*)?$/, ["apiKeys"]],
  [null, /^\/store\/users(\/.*)?$/, ["org"]],
];

/** يُعيد null إن سُمح، وإلا سبب الرفض. */
function storePageBlocked(auth, method, url) {
  if (!auth || auth.role === "owner" || auth.allowedPages == null) return null;
  const path = String(url || "").split("?")[0].replace(/^\/api/, "");
  if (!path.startsWith("/store/")) return null;
  const pages = new Set(Array.isArray(auth.allowedPages) ? auth.allowedPages : []);
  const rule = RULES.find(([m, re]) => (!m || m === method) && re.test(path));
  if (!rule) return "page_not_allowed";
  const [, , need, coding] = rule;
  if (coding && auth.canSendCoding) return null;
  if (need.includes(ANY) ? pages.size > 0 : need.some((p) => pages.has(p))) return null;
  return "page_not_allowed";
}

export { storePageBlocked };
