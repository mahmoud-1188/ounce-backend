import { roundMoney } from "./money.js";
import { postJournalEntry } from "./journal.js";
import { getOpenBusinessDay } from "./saleOps.js";

/**
 * تسوية عمولة البنك — مرّةً لكل شهر لكل فرع.
 *
 * مُستخرَجةٌ من /bank-fees/settle لتستدعيها الإدارة أيضًا: تسويةُ فرعٍ واحد
 * من صفحته، أو توزيعُ عمولة كشف البنك الواحد للمنشأة على الفروع بنسبة ما
 * سجّله كلٌّ منها (HqExpensesTab في المرجع).
 */
function monthRange(period) {
  const [y, m] = String(period || "").split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}

async function recordedNetworkFees(client, branchId, { from, to }) {
  const { rows } = await client.query(
    `select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as v
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and l.account_code = '6500'
        and e.created_at >= $2::date and e.created_at < ($3::date + 1)
        and e.op_type not in ('bank_fee_adjust','bank_fee_refund')
        and e.reversed_of is null
        and not exists (select 1 from journal_entries r where r.reversed_of = e.id)`,
    [branchId, from, to]
  );
  return roundMoney(rows[0]?.v);
}

function shapeAdjustment(a) {
  return { id: a.id, ref: a.ref, period: a.period, recorded: Number(a.recorded), actual: Number(a.actual),
    diff: Number(a.diff), note: a.note || "", by: a.created_by_name || "", date: a.created_at };
}

/** يسوّي شهرًا واحدًا لفرع: الفرق بين الفعليّ والمسجَّل على 6500 ورصيد الشبكة. */
async function settleBankFeePeriod(client, branchId, { period, actual, note = null, userId = null, userName = null }) {
  const range = monthRange(period);
  if (!range) return { error: "invalid_period" };
  const { rows: done } = await client.query(
    "select 1 from bank_fee_adjustments where branch_id = $1 and period = $2",
    [branchId, period]
  );
  if (done.length) return { error: "period_already_settled" };
  const recorded = await recordedNetworkFees(client, branchId, range);
  const diff = roundMoney(actual - recorded);
  const day = await getOpenBusinessDay(client, branchId);
  if (diff > 0.005) {
    const { rows: bal } = await client.query(
      `select coalesce(sum(case when direction='in' then amount else -amount end), 0) as b
         from cash_tx where branch_id = $1 and pool = 'safe' and method = 'network'`,
      [branchId]
    );
    if (diff > Number(bal[0].b) + 0.005) return { error: "insufficient_network_balance", available: roundMoney(bal[0].b) };
  }
  const ref = `BFA-${period}`;
  const { rows } = await client.query(
    `insert into bank_fee_adjustments
       (branch_id, ref, period, recorded, actual, diff, note, created_by, created_by_name, business_day_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
    [branchId, ref, period, recorded, actual, diff, note, userId, userName, day?.id || null]
  );
  const rec = rows[0];
  if (Math.abs(diff) > 0.005) {
    const up = diff > 0;
    const amt = Math.abs(diff);
    const label = `تسوية عمولة البنك ${period} — ${up ? "زيادة" : "نقص"}`;
    await client.query(
      `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
       values ($1,$2,'safe','network',$3,$4,'network_fee_adjust','bank_fee_adjustments',$5,$6,$7)`,
      [branchId, day?.id || null, up ? "out" : "in", amt, rec.id, label, userId]
    );
    await postJournalEntry(client, {
      branchId, businessDayId: day?.id || null,
      opType: up ? "bank_fee_adjust" : "bank_fee_refund", refTable: "bank_fee_adjustments", refId: rec.id,
      description: `تسوية عمولة البنك ${period}: فعليّ ${actual} − مسجَّل ${recorded}${userName && !userId ? ` — من الإدارة (${userName})` : ""}`,
      createdBy: userId,
      lines: up
        ? [{ account: "6500", side: "debit", amount: amt }, { account: "1120", side: "credit", amount: amt }]
        : [{ account: "1120", side: "debit", amount: amt }, { account: "6500", side: "credit", amount: amt }],
    });
  }
  return { adjustment: shapeAdjustment(rec) };
}

export { monthRange, recordedNetworkFees, settleBankFeePeriod, shapeAdjustment };
