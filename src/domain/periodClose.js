import { roundMoney } from "./money.js";

/// إقفال الشهر (migration 061): لقطةٌ ثابتة لأرقام الشهر — صافي كل حساب، والإيراد والمصروف وصافي الربح —
///   باسم من أقفل. القيود تُؤرَّخ بلحظة ترحيلها فلا يدخل شهرًا مضى قيدٌ جديد؛ واللقطة هي «ما كان عليه
///   الشهر يوم أُقفل» يُقارن بها أيّ تقريرٍ لاحق.
const TZ = "Asia/Riyadh";
const PERIOD = /^\d{4}-\d{2}$/;
const currentPeriod = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);

async function monthSnapshot(client, branchId, period) {
  const { rows } = await client.query(
    `select l.account_code, a.name, a.nature, a.statement,
            sum(case when l.side = 'debit' then l.amount else -l.amount end)::numeric as net,
            count(distinct e.id)::int as entries
       from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.code = l.account_code
      where e.branch_id = $1 and to_char(e.created_at at time zone '${TZ}', 'YYYY-MM') = $2
      group by l.account_code, a.name, a.nature, a.statement order by l.account_code`,
    [branchId, period]);
  const { rows: [cnt] } = await client.query(
    `select count(*)::int as n from journal_entries where branch_id = $1 and to_char(created_at at time zone '${TZ}', 'YYYY-MM') = $2`,
    [branchId, period]);
  const accounts = rows.map((r) => ({ code: r.account_code, name: r.name, net: roundMoney(Number(r.net)) }));
  const inc = rows.filter((r) => r.statement === "income");
  const revenue = roundMoney(-inc.filter((r) => r.nature === "credit").reduce((s, r) => s + Number(r.net), 0));
  const expenses = roundMoney(inc.filter((r) => r.nature === "debit").reduce((s, r) => s + Number(r.net), 0));
  return { period, entries: cnt.n, accounts, revenue, expenses, netIncome: roundMoney(revenue - expenses) };
}

async function closeMonth(client, branchId, period, { by, kind }) {
  if (!PERIOD.test(String(period || ""))) return { error: "invalid_period" };
  if (period >= currentPeriod()) return { error: "period_not_ended" };
  const { rows: ex } = await client.query("select id from period_closes where branch_id = $1 and period = $2", [branchId, period]);
  if (ex[0]) return { error: "already_closed" };
  const snapshot = await monthSnapshot(client, branchId, period);
  const { rows } = await client.query(
    `insert into period_closes (branch_id, period, closed_by, closed_by_kind, snapshot) values ($1,$2,$3,$4,$5) returning *`,
    [branchId, period, by, kind, JSON.stringify(snapshot)]);
  await client.query(
    `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',null,'period_closes',$2,$3)`,
    [branchId, rows[0].id, JSON.stringify({ kind: "close_month", period, by, byKind: kind, netIncome: snapshot.netIncome })]);
  return { close: shapeClose(rows[0]) };
}

const shapeClose = (r) => ({ id: r.id, period: r.period, closedAt: r.closed_at, closedBy: r.closed_by, kind: r.closed_by_kind, snapshot: r.snapshot || {} });

/// حالة سنة الفرع: الأشهر التي فيها قيود حتى الشهر الماضي، المقفل منها وغير المقفل، وقفل الفترات
async function fiscalStatus(client, branchId) {
  const { rows: months } = await client.query(
    `select to_char(created_at at time zone '${TZ}', 'YYYY-MM') as p, count(*)::int as n
       from journal_entries where branch_id = $1 group by 1 order by 1`, [branchId]);
  const { rows: closes } = await client.query("select * from period_closes where branch_id = $1 order by period", [branchId]);
  const { rows: [st] } = await client.query("select lock_all::text as lock_all, lock_posted::text as lock_posted from branch_settings where branch_id = $1", [branchId]);
  const cur = currentPeriod();
  const closed = new Set(closes.map((c) => c.period));
  return {
    current: cur,
    lockAll: st?.lock_all || null, lockPosted: st?.lock_posted || null,
    months: months.filter((m) => m.p < cur).map((m) => ({ period: m.p, entries: m.n, closed: closed.has(m.p) })),
    closes: closes.map(shapeClose),
  };
}

const shapeYearClose = (r) => ({
  ...(r.snapshot || {}), id: r.id, ref: r.ref, closedAt: r.closed_at, periodStart: r.period_start,
  ledgerRevenue: Number(r.revenue) || 0, ledgerExpenses: Number(r.expenses) || 0, ledgerNetIncome: Number(r.net_income) || 0,
  closingEntryId: r.closing_entry_id, notes: r.notes || "", server: true,
});

/**
 * إقفال السنة: قيدٌ ينقل رصيد كل حساب دخلٍ (منذ آخر إقفال) إلى 3300 الأرباح المحتجزة،
 * فتبدأ السنة التالية بحسابات دخلٍ صفرية. `snapshot` أرصدة الواجهة الختامية كما يحسبها التطبيق
 * (أساس التدفّقات بعده) تُحفظ كما هي. تحذيرٌ لا منع: أشهرٌ ماضية لم تُقفل.
 */
async function closeYear(client, branchId, { userId, snapshot = {}, notes = "", postJournal }) {
  await client.query("select pg_advisory_xact_lock(hashtext('yearclose:' || $1::text))", [branchId]);
  const { rows: last } = await client.query(
    "select closed_at from fiscal_closures where branch_id = $1 and ref is not null order by closed_at desc limit 1", [branchId]);
  const since = last[0]?.closed_at || null;
  const { rows } = await client.query(
    `select l.account_code, a.nature, sum(case when l.side = 'debit' then l.amount else -l.amount end)::numeric as net
       from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.code = l.account_code
      where e.branch_id = $1 and a.statement = 'income' and e.op_type <> 'year_close' and ($2::timestamptz is null or e.created_at > $2)
      group by l.account_code, a.nature having sum(case when l.side = 'debit' then l.amount else -l.amount end) <> 0
      order by l.account_code`, [branchId, since]);
  if (!rows.length) return { error: "nothing_to_close" };
  const lines = [];
  let revenue = 0, expenses = 0, netH = 0;
  for (const r of rows) {
    const h = Math.round(Number(r.net) * 100);
    netH += h;
    if (r.nature === "credit") revenue -= h; else expenses += h;
    lines.push({ account: r.account_code, side: h > 0 ? "credit" : "debit", amount: Math.abs(h) / 100 });
  }
  // صافي الدخل = −(مجموع أرصدة حسابات الدخل): ربحٌ يُقيَّد دائنًا في 3300، وخسارةٌ مدينًا
  if (netH !== 0) lines.push({ account: "3300", side: netH < 0 ? "credit" : "debit", amount: Math.abs(netH) / 100 });
  const { rows: cnt } = await client.query("select count(*)::int + 1 as n from fiscal_closures where branch_id = $1 and ref is not null", [branchId]);
  const ref = `FYC-${String(cnt[0].n).padStart(4, "0")}`;
  const entryId = await postJournal({
    branchId, businessDayId: null, opType: "year_close", refTable: "fiscal_closures", refId: null,
    description: `إقفال السنة المالية ${ref}`, createdBy: userId, lines,
  });
  const { rows: ins } = await client.query(
    `insert into fiscal_closures (branch_id, period, closed_by, ref, period_start, revenue, expenses, net_income, closing_entry_id, snapshot, notes)
     values ($1, (now() at time zone '${TZ}')::date, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
    [branchId, userId, ref, since, revenue / 100, expenses / 100, -netH / 100, entryId, JSON.stringify(snapshot || {}), String(notes || "").slice(0, 500)]);
  await client.query("update journal_entries set ref_id = $1 where id = $2", [ins[0].id, entryId]);
  await client.query(
    `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',$2,'fiscal_closures',$3,$4)`,
    [branchId, userId, ins[0].id, JSON.stringify({ kind: "close_year", ref, netIncome: -netH / 100 })]);
  return { closure: shapeYearClose(ins[0]) };
}

/** قبل إقفال السنة: الأشهر الماضية غير المُقفلة (تحذير)، ودخل الفترة منذ آخر إقفال. */
async function yearCloseChecks(client, branchId) {
  const st = await fiscalStatus(client, branchId);
  const { rows: last } = await client.query(
    "select closed_at from fiscal_closures where branch_id = $1 and ref is not null order by closed_at desc limit 1", [branchId]);
  const since = last[0]?.closed_at || null;
  const { rows: [ytd] } = await client.query(
    `select coalesce(sum(case when a.nature = 'credit' then -(case when l.side='debit' then l.amount else -l.amount end) else 0 end), 0)::numeric as revenue,
            coalesce(sum(case when a.nature = 'debit' then (case when l.side='debit' then l.amount else -l.amount end) else 0 end), 0)::numeric as expenses
       from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.code = l.account_code
      where e.branch_id = $1 and a.statement = 'income' and e.op_type <> 'year_close' and ($2::timestamptz is null or e.created_at > $2)`, [branchId, since]);
  const openMonths = st.months.filter((m) => !m.closed).map((m) => m.period);
  return {
    since, revenue: roundMoney(Number(ytd.revenue)), expenses: roundMoney(Number(ytd.expenses)),
    netIncome: roundMoney(Number(ytd.revenue) - Number(ytd.expenses)),
    warnings: openMonths.length ? [`أشهرٌ ماضية لم تُقفل: ${openMonths.join("، ")}`] : [],
  };
}

async function listYearCloses(client, branchId) {
  const { rows } = await client.query(
    "select * from fiscal_closures where branch_id = $1 and ref is not null order by closed_at desc", [branchId]);
  return rows.map(shapeYearClose);
}

export { closeMonth, closeYear, fiscalStatus, listYearCloses, monthSnapshot, shapeClose, shapeYearClose, yearCloseChecks };
