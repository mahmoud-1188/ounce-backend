import { PURITY } from "./weight.js";

/**
 * صافي الفرع بالوزن بعد الالتزامات — نفس معادلة بطاقة الفرع (ounce-frontend/src/domain/netWeight.js):
 * الذهب المملوك + النقد كلّه بسعر اليوم − الالتزامات (الدائنون والرواتب والضريبة الصافية).
 * الذهب المملوك: القطع غير المباعة والكسر القائم وذهب الخزنة بعد ما علينا ذهبًا للموردين، والذمم المدينة تُعرض منفصلة.
 */
const CASH_CODES = ["1110", "1120", "1130", "1140", "1150", "1160"];
const RECEIVABLE_CODES = ["1310", "1315", "1320", "2350"];
const VAT_OUT = ["2220", "2225"], VAT_IN = "1360";
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

function netWeightOf({ bal = {}, gold24 = 0, price24 = 0, baseKarat = 21 }) {
  const k = Number(baseKarat) === 24 ? 24 : 21;
  const purity = PURITY[k] || k / 24;
  const perGram = (Number(price24) || 0) * purity;
  const toG = (v) => (perGram > 0 ? (Number(v) || 0) / perGram : 0);
  const cash = r2(CASH_CODES.reduce((a, c) => a + (bal[c] || 0), 0));
  const liab = Object.keys(bal).filter((c) => c.startsWith("2") && c !== "2350" && !VAT_OUT.includes(c))
    .reduce((a, c) => a + Math.max(0, -(bal[c] || 0)), 0);
  const vatNet = VAT_OUT.reduce((a, c) => a - (bal[c] || 0), 0) - (bal[VAT_IN] || 0);
  const liabilities = r2(liab + vatNet);
  const receivables = r2(RECEIVABLE_CODES.reduce((a, c) => a + Math.max(0, bal[c] || 0), 0));
  const goldK = r3((Number(gold24) || 0) / purity);
  const net = r3(goldK + toG(cash) - toG(liabilities));
  return {
    karat: k, priceMissing: !(perGram > 0),
    gold: r3(goldK), cash, cashGrams: r3(toG(cash)), liabilities, liabilitiesGrams: r3(toG(liabilities)),
    receivables, receivablesGrams: r3(toG(receivables)),
    net, withReceivables: r3(net + toG(receivables)), value: r2(net * perGram),
  };
}

async function branchNetWeights(client, branchIds, { price24 = 0, baseKarat = 21 } = {}) {
  if (!branchIds.length) return new Map();
  const { rows: jl } = await client.query(
    `select e.branch_id, l.account_code, coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as b
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = any($1) group by e.branch_id, l.account_code`, [branchIds]);
  // الذهب المملوك كما تعرضه شاشة المخزون في الفرع: قطعٌ غير مباعة · كسرٌ قائم · ذهب الخزنة — ناقص ما علينا ذهبًا (2xxx في دفتر الوزن)
  const { rows: inv } = await client.query(
    `select i.branch_id, i.karat, sum(i.weight) as w from items i join item_units u on u.item_id = i.id
      where i.branch_id = any($1) and not u.sold and not u.issued group by i.branch_id, i.karat`, [branchIds]);
  const { rows: scr } = await client.query(
    `select branch_id, coalesce(karat_final, karat_est) as karat, sum(coalesce(weight_final, weight_est)) as w from scrap_items
      where branch_id = any($1) and stage <> 'used' and consumed_at is null and converted_item_id is null
      group by branch_id, coalesce(karat_final, karat_est)`, [branchIds]);
  const { rows: sg } = await client.query(
    `select branch_id, karat, sum(case when direction = 'in' then weight else -weight end) as w from safe_gold_tx
      where branch_id = any($1) group by branch_id, karat`, [branchIds]);
  const { rows: owed } = await client.query(
    `select branch_id, coalesce(sum(w), 0) as w from (
        select branch_id, to_account as acc, fine_weight as w from gold_ledger_entries where branch_id = any($1)
        union all
        select branch_id, from_account, -fine_weight from gold_ledger_entries where branch_id = any($1)) x
      where acc like '2%' group by branch_id`, [branchIds]);
  const fine = (w, k) => (Number(w) || 0) * (PURITY[k] || Number(k) / 24 || 0);
  const bal = new Map(branchIds.map((id) => [id, {}]));
  for (const r of jl) bal.get(r.branch_id)[r.account_code] = Number(r.b) || 0;
  const gold = new Map(branchIds.map((id) => [id, 0]));
  const add = (id, v) => gold.set(id, gold.get(id) + v);
  for (const r of inv) add(r.branch_id, fine(r.w, r.karat));
  for (const r of scr) add(r.branch_id, fine(r.w, r.karat));
  for (const r of sg) if (Number(r.w) > 0) add(r.branch_id, fine(r.w, r.karat));
  for (const r of owed) add(r.branch_id, Math.min(0, Number(r.w) || 0));
  return new Map(branchIds.map((id) => [id, netWeightOf({ bal: bal.get(id), gold24: gold.get(id), price24, baseKarat })]));
}

export { netWeightOf, branchNetWeights };
