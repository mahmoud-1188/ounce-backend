import { POOL_ACCOUNT } from "./cashPools.js";
import { PURITY } from "./weight.js";

/**
 * صحّة الدفتر (المرجع 5.2.0: auditHealth) — على الخادم ومن الدفاتر كاملةً، لا من آخر 2000 قيد في الواجهة.
 * الميزان يُحسب ويُعرض ولا يُنبّه — ومن لم يفتحه لا يعرف أن دفتره انكسر. الفحص يجري ويظهر حيث يُرى.
 *   ① توازن الدفتر كلّه وكل قيد  ② الصناديق (cash_tx) مقابل حساباتها في الأستاذ
 *   ③ أصلٌ وزنيّ سالب  ④ المخزون المملوك بالوزن مقابل 1210 في الدفتر الوزني
 */
async function ledgerHealth(client, branchId) {
  const alerts = [];
  const add = (level, title, why, where) => alerts.push({ level, title, why, where });
  const money = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const { rows: [tb] } = await client.query(
    `select coalesce(sum(case when l.side='debit' then l.amount else 0 end),0)::numeric as d,
            coalesce(sum(case when l.side='credit' then l.amount else 0 end),0)::numeric as c
       from journal_lines l join journal_entries e on e.id = l.entry_id where e.branch_id = $1`, [branchId]);
  const gap = Math.round((Number(tb.d) - Number(tb.c)) * 100);
  if (Math.abs(gap) >= 2) add("block", "الميزان لا يتوازن", `فرق ${money(gap / 100)} بين المدين والدائن — لا تُسلَّم منه قائمة`, "الأستاذ العام ← الشجرة");

  const { rows: unb } = await client.query(
    `select e.id, e.op_type, sum(case when l.side='debit' then l.amount else -l.amount end)::numeric as diff
       from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.branch_id = $1 group by e.id, e.op_type
     having abs(sum(case when l.side='debit' then l.amount else -l.amount end)) >= 0.02 limit 20`, [branchId]);
  if (unb.length) add("block", `${unb.length} قيدًا غير متوازن`, `أوّلها ${unb[0].id.slice(0, 8).toUpperCase()} (${unb[0].op_type}) بفرق ${money(Number(unb[0].diff))}`, "الأستاذ العام ← اليوميات");

  // ② كل صندوقٍ في cash_tx يقابله حسابه في الأستاذ — فرقٌ بينهما حركةٌ بلا قيد أو قيدٌ بلا حركة
  const { rows: pools } = await client.query(
    `select pool, method, sum(case when direction='in' then amount else -amount end)::numeric as bal
       from cash_tx where branch_id = $1 group by pool, method`, [branchId]);
  const poolByAcc = {};
  for (const p of pools) {
    const acc = POOL_ACCOUNT[p.pool]?.[p.method === "network" ? "network" : "cash"];
    if (acc) poolByAcc[acc] = (poolByAcc[acc] || 0) + Number(p.bal);
  }
  const codes = Object.keys(poolByAcc);
  if (codes.length) {
    const { rows: led } = await client.query(
      `select l.account_code as code, sum(case when l.side='debit' then l.amount else -l.amount end)::numeric as bal
         from journal_lines l join journal_entries e on e.id = l.entry_id
        where e.branch_id = $1 and l.account_code = any($2::text[]) group by l.account_code`, [branchId, codes]);
  const ledBy = Object.fromEntries(led.map((r) => [r.code, Number(r.bal)]));
    const off = codes.map((c) => ({ code: c, pool: poolByAcc[c], ledger: ledBy[c] || 0 }))
      .filter((x) => Math.abs(x.pool - x.ledger) >= 0.01);
    if (off.length) {
      add("warn", "الصناديق لا تطابق الأستاذ",
        off.map((x) => `${x.code}: الصندوق ${money(x.pool)} · الأستاذ ${money(x.ledger)}`).join(" · ") + " — حركةٌ بلا قيد أو قيدٌ بلا حركة",
        "الأستاذ العام ← النقدية");
    }
  }

  // ③ ذهبٌ خرج من أصلٍ أكثر مما دخله
  const { rows: gold } = await client.query(
    `select acct, sum(fine)::numeric as fine from (
        select to_account as acct, fine_weight as fine from gold_ledger_entries where branch_id = $1 and to_account is not null
        union all select from_account, -fine_weight from gold_ledger_entries where branch_id = $1 and from_account is not null
      ) t where acct like '1%' group by acct having sum(fine) < -0.001`, [branchId]);
  if (gold.length) add("warn", "أصلٌ وزنيّ سالب", gold.map((g) => `${g.acct}: ${Number(g.fine).toFixed(3)} جم24`).join(" · ") + " — ذهبٌ خرج أكثر مما دخل", "الأستاذ العام ← الذهب");

  // ④ المخزون المملوك بالوزن (معادل 24) مقابل رصيد 1210 في الدفتر الوزني
  const { rows: [inv] } = await client.query(
    `select coalesce(sum(i.weight * case i.karat ${Object.entries(PURITY).map(([k, p]) => `when ${k} then ${p}`).join(" ")} else i.karat / 24.0 end), 0)::numeric as fine
       from item_units u join items i on i.id = u.item_id
      where i.branch_id = $1 and u.sold = false and (u.issued = false or u.held = true)`, [branchId]);
  const { rows: [g1210] } = await client.query(
    `select coalesce(sum(case when to_account = '1210' then fine_weight else 0 end) - sum(case when from_account = '1210' then fine_weight else 0 end), 0)::numeric as fine
       from gold_ledger_entries where branch_id = $1 and (to_account = '1210' or from_account = '1210')`, [branchId]);
  const invFine = Number(inv.fine), ledFine = Number(g1210.fine);
  if (Math.abs(invFine - ledFine) >= 0.01) {
    add("warn", "المخزون لا يطابق الدفتر الوزني",
      `القطع المملوكة ${invFine.toFixed(3)} جم24 · رصيد 1210 ${ledFine.toFixed(3)} جم24 — فرق ${(invFine - ledFine).toFixed(3)} جم24`,
      "المخزون ← الجرد");
  }

  return {
    ok: !alerts.some((a) => a.level === "block"),
    blocks: alerts.filter((a) => a.level === "block").length,
    warns: alerts.filter((a) => a.level === "warn").length,
    alerts, checkedAt: new Date().toISOString(),
  };
}

export { ledgerHealth };
