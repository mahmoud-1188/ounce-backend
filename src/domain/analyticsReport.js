import { PURITY } from "./weight.js";

/**
 * تقرير التحليلات المقارنة — نظير HqAnalytics.js في المرجع، لكن مبنيّ
 * على استعلامات SQL حيّة بدل "لقطات" مستوردة يدويًّا لكل فرع.
 *
 * ⚠ يُستدعى من GET /api/store/analytics فقط (مستخدم مركزي حقيقي) — لا
 * نظير له في /api/hq القديم (فرع is_hq واحد): المقارنة بين الفروع لا
 * معنى تشغيليًّا لها من داخل فرعٍ ينظر لنفسه، فلم تُضَف هناك.
 *
 * @param {import('pg').PoolClient} client - عميلٌ داخل withoutBranch (نفس نمط consolidatedReport.js)
 * @param {Array<{id: string, ref: string, name: string}>} branches
 * @param {string} periodStart - أول يوم في الشهر المطلوب (YYYY-MM-DD)
 * @returns {Promise<{branches: object[], byMethod: object[], byKarat: object[], topSellers: object[]}>}
 */
async function buildAnalyticsReport(client, branches, periodStart) {
  if (!branches.length) return { branches: [], byMethod: [], byKarat: [], topSellers: [] };
  const branchIds = branches.map((b) => b.id);
  const prevPeriodStart = shiftMonth(periodStart, -1);

  // ⚠ الشهر الحالي والسابق في استعلامٍ واحد (case) بدل استعلامين
  // منفصلين — نفس عدد الصفوف المرجَعة، حساب نموٍّ أبسط في الطبقة العليا.
  const { rows: salesRows } = await client.query(
    `select branch_id,
            count(*) filter (where date >= $2::date and date < ($2::date + interval '1 month'))::int as sales_count,
            coalesce(sum(net_amount) filter (where date >= $2::date and date < ($2::date + interval '1 month')), 0) as sales_net,
            coalesce(sum(net_amount) filter (where date >= $3::date and date < ($3::date + interval '1 month')), 0) as sales_prev_net
       from sales
      where branch_id = any($1)
        and date >= $3::date and date < ($2::date + interval '1 month')
      group by branch_id`,
    [branchIds, periodStart, prevPeriodStart]
  );

  const { rows: methodRows } = await client.query(
    `select branch_id, payment_method,
            coalesce(sum(net_amount), 0) as total
       from sales
      where branch_id = any($1)
        and date >= $2::date and date < ($2::date + interval '1 month')
      group by branch_id, payment_method`,
    [branchIds, periodStart]
  );

  const { rows: stockRows } = await client.query(
    `select i.branch_id, i.karat,
            coalesce(sum(i.weight), 0) as weight
       from items i
       join item_units u on u.item_id = i.id
      where i.branch_id = any($1) and u.sold = false
      group by i.branch_id, i.karat`,
    [branchIds]
  );

  const { rows: soldRows } = await client.query(
    `select i.branch_id, coalesce(sum(i.weight), 0) as weight
       from item_units u
       join items i on i.id = u.item_id
       join sale_lines sl on sl.item_id = i.id
       join sales s on s.id = sl.sale_id
      where i.branch_id = any($1) and u.sold = true
        and s.date >= $2::date and s.date < ($2::date + interval '1 month')
      group by i.branch_id`,
    [branchIds, periodStart]
  );

  const { rows: staffRows } = await client.query(
    `select branch_id, count(*)::int as staff
       from users
      where branch_id = any($1) and active = true
      group by branch_id`,
    [branchIds]
  );

  const { rows: sellerRows } = await client.query(
    `select s.branch_id, coalesce(s.seller_name, u.name, 'غير محدَّد') as seller_name,
            coalesce(sum(s.net_amount), 0) as total
       from sales s
       left join users u on u.id = s.seller_id
      where s.branch_id = any($1)
        and s.date >= $2::date and s.date < ($2::date + interval '1 month')
      group by s.branch_id, coalesce(s.seller_name, u.name, 'غير محدَّد')`,
    [branchIds, periodStart]
  );

  const byBranch = new Map(
    branches.map((b) => [
      b.id,
      {
        branchId: b.id, branchRef: b.ref, branchName: b.name,
        sales30: 0, salesPrev30: 0, salesCount30: 0,
        stockFine24: 0, soldFine30: 0, creditOutstanding: 0,
        staff: 0, growth: null, turnover: 0, perStaff: 0,
      },
    ])
  );

  for (const r of salesRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    b.sales30 = Number(r.sales_net);
    b.salesPrev30 = Number(r.sales_prev_net);
    b.salesCount30 = r.sales_count;
  }
  for (const r of stockRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    const purity = PURITY[r.karat] || Number(r.karat) / 24;
    b.stockFine24 += Number(r.weight) * purity;
  }
  for (const r of soldRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    b.soldFine30 = Number(r.weight);
  }
  for (const r of staffRows) {
    const b = byBranch.get(r.branch_id);
    if (!b) continue;
    b.staff = r.staff;
  }

  // ⚠ آجل (payment_method = 'credit') ذمّة قائمة لا حركة شهرٍ فقط — تعمّد
  // استخدام رصيد الحساب 1310 كما في consolidatedReport.js بدل مجموع
  // مبيعات الآجل هذا الشهر، لأن الأول "كم مستحقٌ الآن؟" والثاني "كم بيع
  // آجلًا هذا الشهر؟" — سؤالان مختلفان. نكتفي هنا بالثاني (من methodRows)
  // لأن الرصيد القائم يتطلب استعلام journal_lines المُستخرَج بالفعل في
  // consolidatedReport.js — يُدمَج في الطبقة العليا (store.routes.js) لا
  // يُكرَّر هنا.
  for (const b of byBranch.values()) {
    b.growth = b.salesPrev30 > 0 ? Math.round(((b.sales30 - b.salesPrev30) / b.salesPrev30) * 100) : null;
    b.turnover = b.stockFine24 > 0 ? Math.round((b.soldFine30 / b.stockFine24) * 100) / 100 : 0;
    b.perStaff = b.staff > 0 ? Math.round(b.sales30 / b.staff) : 0;
  }

  const methodAcc = {};
  for (const r of methodRows) {
    methodAcc[r.payment_method] = (methodAcc[r.payment_method] || 0) + Number(r.total);
    const b = byBranch.get(r.branch_id);
    if (b && r.payment_method === "credit") b.creditOutstanding = (b.creditOutstanding || 0) + Number(r.total);
  }
  const methodTotal = Object.values(methodAcc).reduce((a, v) => a + v, 0) || 1;
  const METHOD_NAMES = { cash: "نقد", card: "شبكة", credit: "آجل", split: "مقسّم" };
  const byMethod = Object.entries(methodAcc)
    .map(([m, total]) => ({ method: METHOD_NAMES[m] || m, total, pct: Math.round((total / methodTotal) * 100) }))
    .sort((a, b) => b.total - a.total);

  const karatAcc = {};
  for (const r of stockRows) {
    karatAcc[r.karat] = (karatAcc[r.karat] || 0) + Number(r.weight) * (PURITY[r.karat] || Number(r.karat) / 24);
  }
  const karatTotal = Object.values(karatAcc).reduce((a, v) => a + v, 0) || 1;
  const byKarat = Object.entries(karatAcc)
    .map(([karat, weight]) => ({ karat: Number(karat), weight, pct: Math.round((weight / karatTotal) * 100) }))
    .sort((a, b) => b.karat - a.karat);

  const topSellers = sellerRows
    .map((r) => ({
      branchId: r.branch_id,
      branchName: byBranch.get(r.branch_id)?.branchName || "",
      sellerName: r.seller_name,
      total: Number(r.total),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  return {
    branches: branches.map((b) => byBranch.get(b.id)),
    byMethod,
    byKarat,
    topSellers,
  };
}

/** يزيح شهرًا (موجب أو سالب) عن تاريخٍ بصيغة YYYY-MM-DD، ويُرجع نفس الصيغة. */
function shiftMonth(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

export { buildAnalyticsReport };
