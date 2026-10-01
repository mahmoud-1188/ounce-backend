// نواة رقابة البيع المشتركة (المرجع: ت١ «صحة الدفاتر» — saleGuards / saleVatOf).
//
// كل مسارات البيع (الفاتورة · البيع بالوزن · جزء الطقم) تحسب الضريبة وتفحص الهوية
// والأرضية والآجل بهذه الدوالّ — لا نسخة لكل مسار، فلا يفلت مسارٌ من رقابةٍ يخضع لها غيره.

import { withBranch } from "../db.js";
import { approvalGate } from "./approvals.js";
import { loadModules, modCfg, modOn } from "./modules.js";
import { PURITY } from "./weight.js";

const H = (v) => Math.round((Number(v) || 0) * 100);
const fromH = (h) => Math.round(h) / 100;
const fmt = (v) => Number(v || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * ضريبة الفاتورة الشاملة سطرًا بسطر بالهللة — كما يحسبها المستند الإلكتروني (einvoice.docOf) حرفيًّا،
 * فضريبة القيد (2220) = ضريبة الفاتورة المُبلَّغة. lines: [{ unitPrice, quantity }].
 */
function saleVat(lines = [], { taxApplicable = false, rate = 0 } = {}) {
  const r = Number(rate) || 0;
  let gross = 0, tax = 0;
  for (const l of lines) {
    const g = H(Number(l.unitPrice) * (Number(l.quantity) || 1));
    gross += g;
    if (taxApplicable && r > 0) tax += g - Math.round(g / (1 + r));
  }
  return { total: fromH(gross), taxAmount: fromH(tax), netAmount: fromH(gross - tax) };
}

/**
 * أرضية السعر: لا بيع تحت تكلفة القطعة ولا تحت قيمة ذهبها الصافي بسعر اليوم.
 * lines: [{ ref, karat, weight, costPerGram, workmanship, price }] — الوزن والمصنعية لما يُباع فعلًا
 * (السطر الجزئي بوزنه المباع ونصيبه). يُعيد أوّل مخالفةٍ بنصّها أو null.
 */
function priceFloorIssue(lines = [], price24 = 0) {
  for (const l of lines) {
    const w = Number(l.weight) || 0;
    const cost = (Number(l.costPerGram) || 0) * w + (Number(l.workmanship) || 0);
    const metal = (Number(price24) || 0) * (PURITY[l.karat] || Number(l.karat) / 24 || 0) * w;
    const floor = Math.max(cost, metal);
    if (floor > 0 && H(l.price) < H(floor) - 1) {
      return `${l.ref || "القطعة"}: السعر ${fmt(l.price)} أقل من ${cost >= metal ? "تكلفتها" : "قيمة ذهبها اليوم"} ${fmt(floor)}`;
    }
  }
  return null;
}

/** رصيد العميل الآجل وأقدم فاتورةٍ آجلة باقٍ منها شيء — التحصيل يُطفئ الأقدم أوّلًا. */
async function customerCredit(client, branchId, customerId) {
  const { rows: inv } = await client.query(
    `select date as created_at, total from sales
      where branch_id = $1 and customer_id = $2 and payment_method = 'credit'
      order by date`,
    [branchId, customerId]
  );
  const { rows: rc } = await client.query(
    "select coalesce(sum(abs(amount)), 0) as paid from receipts where branch_id = $1 and customer_id = $2",
    [branchId, customerId]
  );
  let paid = H(rc[0].paid);
  let balance = 0, oldest = null;
  for (const s of inv) {
    const use = Math.min(H(s.total), paid);
    paid -= use;
    const left = H(s.total) - use;
    if (left > 0) { balance += left; if (!oldest) oldest = s.created_at; }
  }
  return { balance: fromH(balance), oldestUnpaidAt: oldest };
}

/** حدّ الآجل: رصيد العميل مع هذا الجزء لا يتجاوز حدّه (أو افتراضي الفرع)، ولا آجلَ لمن عليه فاتورةٌ متأخّرة. */
async function creditLimitIssue(client, branchId, customerId, amount) {
  if (!customerId || !(amount > 0)) return null;
  const { rows: c } = await client.query("select name, credit_limit from customers where id = $1 and branch_id = $2", [customerId, branchId]);
  if (!c[0]) return null;
  const { rows: st } = await client.query(
    "select credit_limit_default, credit_overdue_days from branch_settings where branch_id = $1", [branchId]);
  const limit = Number(c[0].credit_limit ?? st[0]?.credit_limit_default) || 0;
  const days = Number(st[0]?.credit_overdue_days) || 0;
  if (!(limit > 0) && !(days > 0)) return null;
  const { balance, oldestUnpaidAt } = await customerCredit(client, branchId, customerId);
  const after = fromH(H(balance) + H(amount));
  if (limit > 0 && H(after) > H(limit)) {
    return `حدّ الآجل لـ${c[0].name} ${fmt(limit)} — عليه ${fmt(balance)} ومع هذه الفاتورة ${fmt(after)}`;
  }
  if (days > 0 && oldestUnpaidAt) {
    const age = (Date.now() - new Date(oldestUnpaidAt).getTime()) / 86400000;
    if (age > days) return `على ${c[0].name} فاتورةٌ آجلة لم تُسدَّد منذ ${Math.floor(age)} يومًا (الحدّ ${days} يومًا)`;
  }
  return null;
}

/**
 * ما دفعه العميل نفسه نقدًا في آخر 24 ساعة (برقمه أو بهويته) — يُضاف لما يدفعه الآن،
 * فتقسيم المبلغ على فواتير صغيرة لا يتجاوز حدّ مكافحة غسل الأموال.
 */
async function amlPriorCash(client, branchId, { customerId = null, idNumber = "" } = {}) {
  const id = String(idNumber || "").trim().toUpperCase();
  if (!customerId && !id) return 0;
  const { rows } = await client.query(
    `select coalesce(sum(case when payment_method = 'cash' then total - coalesce(deposit_applied, 0) - coalesce(gift_applied, 0)
                              when payment_method = 'split' then cash_part else 0 end), 0) as cash
       from sales
      where branch_id = $1 and date > now() - interval '24 hours'
        and (($2::uuid is not null and customer_id = $2) or ($3 <> '' and upper(kyc->>'idNumber') = $3))`,
    [branchId, customerId, id]
  );
  return Number(rows[0].cash) || 0;
}

/**
 * الهوية فوق حدّ النقد (وحدة aml) بتجميع 24 ساعة. يُعيد { kyc } أو { error } أو {} حين لا يلزم.
 * `validIdNumber` تُمرَّر من مسار العملاء كي لا تتكرّر القاعدة.
 */
async function amlCheck(client, branchId, { cashDue = 0, customerId = null, body = {}, validIdNumber }) {
  const mods = await loadModules(client, branchId);
  const th = Number(modCfg(mods, "aml").cashThreshold) || 0;
  if (!modOn(mods, "aml") || !(th > 0) || !(cashDue > 0)) return {};
  let idNo = String(body.kycIdNumber || "").trim().toUpperCase();
  let who = String(body.kycName || "").trim();
  // هوية العميل المسجّلة تسبق المكتوبة — كما كان المسار الرئيسي
  if (customerId) {
    const { rows } = await client.query("select name, id_number from customers where id = $1 and branch_id = $2", [customerId, branchId]);
    if (rows[0]?.id_number) { idNo = String(rows[0].id_number).toUpperCase(); who = rows[0].name; }
    else if (!who && rows[0]) who = rows[0].name;
  }
  const prior = await amlPriorCash(client, branchId, { customerId, idNumber: idNo });
  const cumulative = Math.round((cashDue + prior) * 100) / 100;
  if (cumulative < th) return {};
  if (!validIdNumber(idNo) || !who) return { error: "aml_id_required", threshold: th, cash: cashDue, prior };
  if (customerId && body.kycIdNumber) {
    await client.query("update customers set id_number = coalesce(id_number, $2) where id = $1", [customerId, idNo]);
  }
  return { kyc: { idNumber: idNo, name: who, cash: cashDue, prior, at: new Date().toISOString() } };
}

/**
 * الأرضية والآجل بموافقة: المخالفة تمرّ ببوّابة الاعتماد (الحدّ صفر) — المدير يعتمد نفسه ويُسجَّل،
 * وغيره يُحفظ طلبه بحمولته ويُنفَّذ مرّةً عند اعتماده (approvals[kind] لكل نوع).
 *
 * ⚠ الطلب المعلّق يُعاد خطأً `approval_pending` فتتراجع معاملة البيع كلّها (لا قطعة تُعلَّم مباعة بلا فاتورة)،
 *   ثم يُكتب الطلب في معاملةٍ مستقلّة (`recordPendingApproval`). والاعتماد المستهلَك يتراجع مع أيّ رفضٍ لاحق.
 * يُعيد { error } أو { overrides }.
 */
async function approvalGuards(client, auth, { floorWhy = null, creditWhy = null, total = 0, creditPart = 0, payload = {}, body = {} }) {
  const overrides = {};
  const checks = [
    ["price_floor", floorWhy, total, "priceFloor"],
    ["credit_limit", creditWhy, creditPart, "creditLimit"],
  ].filter(([, why]) => why);
  for (const [kind, why, amount, key] of checks) {
    const approvalId = body.approvals?.[kind] || null;
    const gate = await approvalGate(client, auth, { kind, amount, approvalId, note: why, payload });
    if (gate.error) return gate;
    if (gate.pending) return { error: "approval_pending", request: { kind, amount, note: why, payload } };
    overrides[key] = { why, approvalId: gate.approvalId || null, selfApproved: !!gate.selfApproved };
  }
  return { overrides };
}

/**
 * رقابة مسارات البيع الجانبية (بالوزن · جزء الطقم) — الهوية والأرضية والآجل كما في الفاتورة.
 * line: { ref, karat, weight, costPerGram, workmanship, price }. يُعيد { error } أو { kyc, overrides }.
 */
async function sideSaleGuards(client, auth, { line, total, paymentMethod, customerId, body = {}, price24 = 0, validIdNumber }) {
  const cashDue = paymentMethod === "cash" ? total : 0;
  const aml = await amlCheck(client, auth.branchId, { cashDue, customerId, body, validIdNumber });
  if (aml.error) return aml;
  const floorWhy = priceFloorIssue([line], price24);
  const creditPart = paymentMethod === "credit" ? total : 0;
  const creditWhy = await creditLimitIssue(client, auth.branchId, customerId, creditPart);
  const guards = await approvalGuards(client, auth, { floorWhy, creditWhy, total, creditPart, payload: body, body });
  if (guards.error) return guards;
  return { kyc: aml.kyc || null, overrides: guards.overrides };
}

/** نقاط الولاء (وحدة loyalty): نقطةٌ لكل «sarPerPoint» مدفوعة نقدًا أو شبكة لعميلٍ مسجَّل — لكل مسارات البيع. */
async function awardLoyalty(client, branchId, { customerId, paymentMethod, paid, saleId, ref, userId }) {
  if (!customerId || paymentMethod === "credit" || !(paid > 0)) return 0;
  const mods = await loadModules(client, branchId);
  if (!modOn(mods, "loyalty")) return 0;
  const points = Math.floor(paid / (Number(modCfg(mods, "loyalty").sarPerPoint) || 100));
  if (points > 0) {
    await client.query("insert into loyalty_ledger (branch_id, customer_id, points, sale_id, note, created_by) values ($1,$2,$3,$4,$5,$6)",
      [branchId, customerId, points, saleId, `فاتورة ${ref}`, userId]);
  }
  return points;
}

/**
 * المرتجع يعكس الولاء (المرجع ت١): نقاط الفاتورة تُطرح بنسبة ما رُدّ منها، ولا يُطرح أكثر مما كُسب.
 * يُعيد عدد النقاط المطروحة.
 */
async function reverseLoyalty(client, branchId, { saleId, saleTotal, returnedGross, ref, userId }) {
  if (!saleId || !(Number(saleTotal) > 0) || !(Number(returnedGross) > 0)) return 0;
  const { rows } = await client.query(
    `select customer_id, coalesce(sum(case when points > 0 then points else 0 end), 0)::int as earned,
            coalesce(-sum(case when points < 0 then points else 0 end), 0)::int as reversed
       from loyalty_ledger where branch_id = $1 and sale_id = $2 group by customer_id`,
    [branchId, saleId]
  );
  const row = rows[0];
  if (!row || !(row.earned > 0)) return 0;
  const share = Math.round(row.earned * Math.min(1, Number(returnedGross) / Number(saleTotal)));
  const take = Math.min(share, row.earned - row.reversed);
  if (!(take > 0)) return 0;
  await client.query("insert into loyalty_ledger (branch_id, customer_id, points, sale_id, note, created_by) values ($1,$2,$3,$4,$5,$6)",
    [branchId, row.customer_id, -take, saleId, `مرتجع ${ref || ""}`.trim(), userId]);
  return take;
}

/** يكتب الطلب المعلّق في معاملته ويردّ 202 بحمولته — كما تفعل المصروفات. */
async function recordPendingApproval(res, auth, request) {
  const out = await withBranch(auth.branchId, (client) => approvalGate(client, auth, request));
  if (out.pending) return res.status(202).json({ approvalPending: out.pending });
  return res.status(409).json({ error: "approval_state_changed" });
}

export { reverseLoyalty, awardLoyalty, sideSaleGuards, recordPendingApproval, amlCheck, amlPriorCash, approvalGuards, creditLimitIssue, customerCredit, priceFloorIssue, saleVat };
