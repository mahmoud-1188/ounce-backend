import { POOL_ACCOUNT } from "./cashPools.js";
import { postJournalEntry } from "./journal.js";
import { PURITY } from "./weight.js";

/**
 * صحّة الدفتر (المرجع 5.2.0: auditHealth) — على الخادم ومن الدفاتر كاملةً، لا من آخر 2000 قيد في الواجهة.
 * الميزان يُحسب ويُعرض ولا يُنبّه — ومن لم يفتحه لا يعرف أن دفتره انكسر. الفحص يجري ويظهر حيث يُرى.
 *   ① توازن الدفتر كلّه وكل قيد  ② الصناديق (cash_tx) مقابل حساباتها في الأستاذ
 *   ③ أصلٌ وزنيّ سالب  ④ المخزون المملوك بالوزن مقابل 1210 في الدفتر الوزني
 *   ⑤ عملياتٌ بلا قيد (المرجع ت١ «فحص الدفاتر»): فاتورة · مرتجع · مصروف · شراء · إصلاحٌ بدخل
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

  // ⑤ عملياتٌ بلا قيد — كل مسارٍ يقيّد في معاملته، فالناقص من بياناتٍ قديمة أو مستوردة
  const unposted = await unpostedOps(client, branchId);
  if (unposted.length) {
    const fixable = unposted.filter((u) => u.repairable).length;
    add("warn", `${unposted.length} عمليةً بلا قيد`,
      `${unposted.slice(0, 5).map((u) => `${u.label} ${u.ref}`).join(" · ")}${unposted.length > 5 ? " …" : ""}` +
        (fixable ? ` — ${fixable} منها يُرحَّل قيدها بزرّ المدير` : " — تحتاج قيدًا يدويًا"),
      "المراجعة المحاسبية ← صحة الدفتر");
  }

  return {
    unposted,
    ok: !alerts.some((a) => a.level === "block"),
    blocks: alerts.filter((a) => a.level === "block").length,
    warns: alerts.filter((a) => a.level === "warn").length,
    alerts, checkedAt: new Date().toISOString(),
  };
}

const UNPOSTED_SOURCES = [
  { table: "sales", label: "فاتورة", where: "true" },
  { table: "returns", label: "مرتجع", where: "true" },
  { table: "expenses", label: "مصروف", where: "x.amount > 0" },
  { table: "purchases", label: "شراء", where: "true" },
  { table: "repairs", label: "إصلاح", where: "x.profit > 0" },
];

/** العمليات التي لا يقابلها قيدٌ في الأستاذ. الفاتورة البسيطة (نقد · شبكة · آجل · مقسّم بلا عربونٍ ولا بطاقةٍ ولا بدل) يُعاد بناء قيدها. */
async function unpostedOps(client, branchId) {
  const out = [];
  for (const src of UNPOSTED_SOURCES) {
    const extra = src.table === "sales"
      ? `, (x.payment_method in ('cash','card','credit','split') and coalesce(x.deposit_applied,0) = 0 and coalesce(x.gift_applied,0) = 0
           and coalesce(x.trade_in_value,0) = 0 and x.custom_order_id is null) as repairable`
      : ", false as repairable";
    const { rows } = await client.query(
      `select x.id, x.ref ${extra} from ${src.table} x
        where x.branch_id = $1 and ${src.where}
          and not exists (select 1 from journal_entries e where e.branch_id = $1 and e.ref_id = x.id)
        limit 50`, [branchId]);
    for (const r of rows) out.push({ table: src.table, id: r.id, ref: r.ref || r.id.slice(0, 8), label: src.label, repairable: !!r.repairable });
  }
  return out;
}

/**
 * يُرحّل قيد فاتورةٍ بسيطةٍ بلا قيد — بالحسابات نفسها التي يكتبها مسار البيع اليوم:
 * مدين الصندوق/الشبكة/الذمم (والمقسّم بجزأيه) · دائن 4140 بالصافي و2220 بالضريبة المحفوظة على الفاتورة.
 */
async function repostSale(client, branchId, saleId, userId) {
  const { rows } = await client.query("select * from sales where id = $1 and branch_id = $2 for update", [saleId, branchId]);
  const s = rows[0];
  if (!s) return { error: "sale_not_found" };
  const { rows: has } = await client.query("select 1 from journal_entries where branch_id = $1 and ref_id = $2 limit 1", [branchId, saleId]);
  if (has[0]) return { error: "already_posted" };
  const unsafe = Number(s.deposit_applied) > 0 || Number(s.gift_applied) > 0 || Number(s.trade_in_value) > 0 || s.custom_order_id
    || !["cash", "card", "credit", "split"].includes(s.payment_method);
  if (unsafe) return { error: "needs_manual_entry" };
  const total = Number(s.total) || 0, tax = Number(s.tax_amount) || 0;
  const debit = s.payment_method === "split"
    ? [["1130", Number(s.cash_part) || 0], ["1140", Number(s.network_part) || 0]]
    : [[s.payment_method === "card" ? "1140" : s.payment_method === "credit" ? "1310" : "1130", total]];
  const lines = [
    ...debit.filter(([, a]) => a > 0).map(([account, amount]) => ({ account, side: "debit", amount })),
    { account: "4140", side: "credit", amount: Math.round((total - tax) * 100) / 100 },
    ...(tax > 0 ? [{ account: "2220", side: "credit", amount: tax }] : []),
  ];
  const journalEntryId = await postJournalEntry(client, {
    branchId, businessDayId: s.business_day_id,
    opType: s.payment_method === "credit" ? "sale_credit" : s.payment_method === "card" ? "sale_card" : "sale_cash",
    refTable: "sales", refId: s.id, description: `ترحيل قيد فاتورةٍ قديمة ${s.ref}`, createdBy: userId, lines,
  });
  await client.query(
    `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'sales',$3,$4)`,
    [branchId, userId, s.id, JSON.stringify({ ref: s.ref, repost: true, journalEntryId })]);
  return { ok: true, journalEntryId };
}

export { ledgerHealth, repostSale, unpostedOps };
