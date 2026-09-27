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

export { closeMonth, fiscalStatus, monthSnapshot, shapeClose };
