/**
 * سياسة الإدارة المركزية على شاشات الفروع وعملياتها (المرجع: applyHqPolicy
 * وhqAllowsAction في domain/helpers.js، وتبويبا «الشاشات»/«العمليات»).
 *
 *   • الشاشات: ثلاث حالات لكل شاشة — بيد الفرع (افتراضي) · ممنوعة · ممنوحة.
 *     قيدٌ على (فرعٍ + دور) يحلّ محلّ قيد الدور في كل الفروع. والمنع يغلب
 *     المنح إن اجتمعا — فخطأٌ في الضبط يُغلق لا يفتح.
 *   • العمليات: منعُ الفعل نفسه لا إخفاء شاشته — يُجمع من كل النطاقات
 *     (الفرع للدور، الفرع لكل الأدوار، الدور، الكل) ويُفرض في المعالجات
 *     عبر requireNotDenied.
 */

// شاشات تطبيق الفرع (NAV_REGISTRY في ounce-frontend) — «الرئيسية» لا تُمنع
const BRANCH_SCREENS = [
  ["inventory", "المخزون"], ["sales", "المبيعات"], ["cash", "النقد"], ["expenses", "المصروفات"], ["stocktake", "الجرد"],
  ["addGoods", "التكويد"], ["printing", "إعادة الطباعة"], ["printerSetup", "إعدادات الطابعة"], ["rfidReader", "قارئ RFID"],
  ["rfidSettings", "إعدادات القارئ"], ["salesHistory", "سجل المبيعات"], ["sellerReports", "تقارير البائعين"], ["price", "السعر اليومي"],
  ["reports", "التقارير"], ["scrap", "سجل الكسر"], ["journal", "اليومية"], ["trialBalance", "ميزان المراجعة"], ["bankRecon", "مطابقة البنك"],
  ["supplierLedger", "تقارير المشتريات"], ["officeLedger", "مكاتب التسكير"], ["salesReturn", "المرتجعات والاستبدال"], ["search", "البحث الشامل"],
  ["workday", "يوم العمل"], ["scrapIntake", "استلام الكسر"], ["scrapCustody", "عهدة الكسر"], ["itemEdit", "تعديل القطع"],
  ["categories", "التصنيفات"], ["conversions", "التحويلات"], ["integration", "الربط مع الأنظمة"], ["storeLink", "المتجر الإلكتروني"],
  ["backup", "النسخ الاحتياطي"], ["purchases", "المشتريات"], ["trustAccounts", "الحسابات الجارية"], ["customers", "العملاء"],
  ["reservations", "الحجوزات"], ["safeAudit", "جرد الخزنة"], ["suppliers", "الموردين"], ["taskirat", "تسكيرات"], ["partners", "حسابات الشركاء"],
  ["access", "صلاحيات الوصول"], ["taxReport", "تقرير الضرائب"], ["settings", "الإعدادات"], ["openingCompare", "مقارنة بالافتتاحي"],
  ["financials", "القوائم المالية والزكاة"], ["repairs", "إصلاحات"], ["aiAssistant", "أوقية (المساعد)"], ["navCustomize", "تخصيص القائمة"],
  ["openingBalance", "الرصيد الافتتاحي"], ["fixedAssets", "الأصول الثابتة"], ["payroll", "الرواتب"], ["attendanceHr", "الحضور والإجازات"],
  ["hqReports", "تقرير الفروع"], ["hqDocs", "معاملات الإدارة"], ["codingReport", "تقرير التكويد"], ["queryBuilder", "مُنشئ الاستعلام"],
  ["priceFix", "التثبيت ذهب ↔ نقد"], ["generalLedger", "الأستاذ العام"], ["masterReport", "التقارير الموحّدة"], ["anyStatement", "كشف حساب — أي شيء"],
  ["fullStatements", "القوائم المالية الكاملة"], ["exchange", "التبادل مع الأنظمة"], ["customerReport", "تقرير العملاء"], ["docCycle", "الدورة المستندية"],
  ["reportsHub", "مركز التقارير"], ["accountantReview", "المراجعة المحاسبية"], ["approvals", "الاعتمادات"], ["documents", "الأرشيف"],
  ["bankFees", "تسوية عمولات البنك"], ["showcase", "الاستعراض للزبون"], ["dashboard", "لوحة التحكم"], ["aiAccountant", "المساعد المحاسبي"],
].map(([id, label]) => ({ id, label }));

// ⚠ العمليات المفروضة فعلًا في معالجات الخادم فقط — منعٌ لا يُفرض كذبة
const HQ_ACTIONS = [
  { id: "openDay", label: "فتح يوم العمل", group: "day" },
  { id: "closeDay", label: "إقفال اليوم", group: "day" },
  { id: "cashMove", label: "تحريك النقد بين الخزنة والصندوق والعهدة", group: "cash" },
  { id: "safeMove", label: "إيداع وسحب الخزنة (نقد وذهب)", group: "cash" },
  { id: "expense", label: "تسجيل مصروف", group: "cash" },
  { id: "sale", label: "البيع والمرتجع", group: "trade" },
  { id: "purchase", label: "الشراء والموردون", group: "trade" },
  { id: "buyScrap", label: "شراء كسر من زبون", group: "trade" },
  { id: "addGoods", label: "إدخال البضاعة وتكويدها", group: "stock" },
  { id: "issueOut", label: "إخراج قطعة من النظام", group: "stock" },
  { id: "categories", label: "تعديل التصنيفات", group: "stock" },
  { id: "taskir", label: "التسكير ومكاتب التسكير", group: "stock" },
  { id: "repair", label: "الإصلاحات", group: "stock" },
  { id: "breakStones", label: "تكسير وفصل الفصوص", group: "scrap" },
  { id: "sendScrap", label: "إرسال الكسر للفحص", group: "scrap" },
  { id: "assessScrap", label: "فحص الكسر", group: "scrap" },
  { id: "approveScrap", label: "اعتماد فحص الكسر", group: "scrap" },
  { id: "convertScrap", label: "تحويل كسر إلى مشغول", group: "scrap" },
];
const ACTION_GROUPS = { day: "يوم العمل", cash: "النقد", trade: "البيع والشراء", stock: "المخزون", scrap: "الكسر" };

const SCREEN_IDS = new Set(BRANCH_SCREENS.map((s) => s.id));
const ACTION_IDS = new Set(HQ_ACTIONS.map((a) => a.id));

/** قيد الشاشات لدورٍ في فرع: قيد الفرع يحلّ محلّ قيد الدور العام. */
function screenEntry(policy, branchId, role) {
  const p = policy || {};
  return p.byBranch?.[branchId]?.[role] || p.byRole?.[role] || null;
}

/** العمليات الممنوعة من الإدارة — اتحادُ كل النطاقات. */
function hqDeniedActions(policy, branchId, role) {
  const p = policy || {};
  const scopes = [p.byBranch?.[branchId]?.[role], p.byBranch?.[branchId]?.["*"], p.byRole?.[role], p.byRole?.["*"]];
  const out = new Set();
  for (const s of scopes) (s?.denyActions || []).forEach((a) => out.add(a));
  return [...out];
}

/** يطبّق قيد الشاشات على قائمة صفحاتٍ فعّالة — المنع يغلب المنح. */
function applyScreenPolicy(pages, entry) {
  if (!entry) return pages;
  const deny = new Set(entry.deny || []);
  const out = (pages || []).filter((id) => !deny.has(id));
  for (const id of entry.grant || []) if (!deny.has(id) && !out.includes(id)) out.push(id);
  return out;
}

const cleanEntry = (e) => {
  const deny = [...new Set((e?.deny || []).filter((id) => SCREEN_IDS.has(id)))];
  const d = new Set(deny);
  const grant = [...new Set((e?.grant || []).filter((id) => SCREEN_IDS.has(id) && !d.has(id)))];
  const denyActions = [...new Set((e?.denyActions || []).filter((id) => ACTION_IDS.has(id)))];
  return deny.length || grant.length || denyActions.length ? { deny, grant, denyActions } : null;
};

/** ينظّف سياسةً واردة: أدوار معروفة، فروع المتجر فقط، معرّفات معروفة، ولا مداخل فارغة. */
function sanitizePolicy(input, { roles, branchIds }) {
  const roleOk = (r) => r === "*" || roles.includes(r);
  const clean = (map) => {
    const out = {};
    for (const [r, e] of Object.entries(map || {})) {
      if (!roleOk(r)) continue;
      const c = cleanEntry(e);
      if (c) out[r] = c;
    }
    return out;
  };
  const byRole = clean(input?.byRole);
  const byBranch = {};
  for (const [b, m] of Object.entries(input?.byBranch || {})) {
    if (!branchIds.includes(b)) continue;
    const c = clean(m);
    if (Object.keys(c).length) byBranch[b] = c;
  }
  return { byRole, byBranch };
}

/** ما يُرسل للفرع في bootstrap: قيود الأدوار العامة + قيود هذا الفرع فقط. */
function branchPolicyView(policy, branchId) {
  return { byRole: policy?.byRole || {}, branch: policy?.byBranch?.[branchId] || {} };
}

export { BRANCH_SCREENS, HQ_ACTIONS, ACTION_GROUPS, screenEntry, hqDeniedActions, applyScreenPolicy, sanitizePolicy, branchPolicyView };
