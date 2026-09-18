import { PURITY } from "./weight.js";

/**
 * ⚠ استُخرجت من hq.routes.js (لا كُتبت من الصفر) — نفس منطق تجميع
 * "تقرير الإدارة" حرفيًّا، فُصل ليُستدعى من مسارين مختلفين بنفس السلوك:
 *   • GET /api/hq/report — القديم، مقيّدٌ بفرعٍ واحد مُعلَّم is_hq (نمط
 *     ما قبل store_users، لا يزال مدعومًا لتوافقيةٍ خلفية).
 *   • GET /api/store/report — الجديد، مقيّدٌ بجلسة مستخدمٍ مركزي حقيقية
 *     (storeAuth) — الطريق الصحيح للإدارة المركزية من الآن فصاعدًا.
 *
 * تكرار هذا المنطق في مسارين كان سيعني أن أي تعديل لاحق (حسابٌ جديد
 * يُجمَّع، إصلاح خطأ في حساب الرصيد) يُنسى في أحدهما — لذا استُخرج هنا
 * كمصدر حقيقة واحد يستدعيه كلاهما.
 *
 * @param {import('pg').PoolClient} client - عميلٌ داخل withoutBranch (يتجاوز عزل RLS عمدًا؛ القيد الحقيقي هو أن branches أصلًا مُمرَّرة مُقيَّدة بمتجرٍ واحد من المستدعي)
 * @param {Array<{id: string, ref: string, name: string}>} branches - فروع المتجر/النطاق المطلوب تجميعه فقط — لا كل فروع القاعدة
 * @param {string} periodStart - أول يوم في الشهر المطلوب، بصيغة YYYY-MM-DD
 * @returns {Promise<{branches: object[], totals: object}>}
 */
async function buildConsolidatedReport(client, branches, periodStart) {
  if (!branches.length) return { branches: [], totals: null };
  const branchIds = branches.map((b) => b.id);

  const { rows: salesRows } = await client.query(
    `select branch_id,
            count(*)::int as sales_count,
            coalesce(sum(total), 0) as sales_total,
            coalesce(sum(net_amount), 0) as sales_net
       from sales
      where branch_id = any($1)
        and date >= $2::date and date < ($2::date + interval '1 month')
      group by branch_id`,
    [branchIds, periodStart]
  );

  const { rows: purchaseRows } = await client.query(
    `select branch_id,
            count(*)::int as purchases_count,
            coalesce(sum(weight), 0) as purchases_weight,
            coalesce(sum(weight * cost_per_gram), 0) as purchases_cost
       from lots
      where branch_id = any($1)
        and date_added >= $2::date and date_added < ($2::date + interval '1 month')
      group by branch_id`,
    [branchIds, periodStart]
  );

  const { rows: itemRows } = await client.query(
    `select i.branch_id, i.karat, i.weight, i.cost_per_gram, i.workmanship
       from items i
       join item_units u on u.item_id = i.id
      where i.branch_id = any($1) and u.sold = false`,
    [branchIds]
  );

  const { rows: safeCashRows } = await client.query(
    `select branch_id, method,
            coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
       from cash_tx
      where branch_id = any($1) and pool = 'safe'
      group by branch_id, method`,
    [branchIds]
  );

  const { rows: safeGoldRows } = await client.query(
    `select branch_id, karat,
            coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as balance
       from safe_gold_tx
      where branch_id = any($1)
      group by branch_id, karat`,
    [branchIds]
  );

  const { rows: balanceRows } = await client.query(
    `select e.branch_id, l.account_code,
            coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as balance
       from journal_lines l
       join journal_entries e on e.id = l.entry_id
      where e.branch_id = any($1) and l.account_code in ('1310', '2110')
      group by e.branch_id, l.account_code`,
    [branchIds]
  );

  const byBranch = new Map(
    branches.map((b) => [
      b.id,
      {
        branchId: b.id,
        branchRef: b.ref,
        branchName: b.name,
        sales: { count: 0, total: 0, net: 0 },
        purchases: { count: 0, weight: 0, cost: 0 },
        inventory: { fineWeight: 0, cost: 0 },
        safe: { cash: 0, network: 0, goldFineWeight: 0 },
        receivable: 0,
        payable: 0,
      },
    ])
  );

  for (const r of salesRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    b.sales = { count: r.sales_count, total: Number(r.sales_total), net: Number(r.sales_net) };
  }
  for (const r of purchaseRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    b.purchases = {
      count: r.purchases_count,
      weight: Number(r.purchases_weight),
      cost: Number(r.purchases_cost),
    };
  }
  for (const r of itemRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    const purity = PURITY[r.karat] || Number(r.karat) / 24;
    const weight = Number(r.weight) || 0;
    b.inventory.fineWeight += weight * purity;
    b.inventory.cost += weight * (Number(r.cost_per_gram) || 0) + (Number(r.workmanship) || 0);
  }
  for (const r of safeCashRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    if (r.method === "cash") b.safe.cash = Number(r.balance);
    else if (r.method === "network") b.safe.network = Number(r.balance);
  }
  for (const r of safeGoldRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    const purity = PURITY[r.karat] || Number(r.karat) / 24;
    b.safe.goldFineWeight += Number(r.balance) * purity;
  }
  for (const r of balanceRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    if (r.account_code === "1310") b.receivable = Number(r.balance);
    else if (r.account_code === "2110") b.payable = -Number(r.balance); // دائن بطبيعته: نعكس الإشارة لعرضه رقمًا موجبًا
  }

  const rows = branches.map((b) => byBranch.get(b.id));
  const totals = rows.reduce(
    (acc, b) => {
      acc.salesTotal += b.sales.total;
      acc.salesNet += b.sales.net;
      acc.purchasesCost += b.purchases.cost;
      acc.inventoryFineWeight += b.inventory.fineWeight;
      acc.inventoryCost += b.inventory.cost;
      acc.safeCash += b.safe.cash;
      acc.safeNetwork += b.safe.network;
      acc.safeGoldFineWeight += b.safe.goldFineWeight;
      acc.receivable += b.receivable;
      acc.payable += b.payable;
      return acc;
    },
    {
      salesTotal: 0, salesNet: 0, purchasesCost: 0,
      inventoryFineWeight: 0, inventoryCost: 0,
      safeCash: 0, safeNetwork: 0, safeGoldFineWeight: 0,
      receivable: 0, payable: 0,
    }
  );

  return { branches: rows, totals };
}

export { buildConsolidatedReport };
