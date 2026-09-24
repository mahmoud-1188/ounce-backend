import { roundMoney } from "./money.js";
import { roundWeight } from "./weight.js";

/**
 * إقفال يوم العمل — لقطةٌ لحظية من دفاتر الحركة.
 *
 * مُستخرَجٌ من /day/close ليُستدعى أيضًا من الإدارة (close_day في المرجع:
 * «إقفال يوم الفرع الآن» بالمعالج نفسه) — إقفالان بمنطقين يعني لقطتين
 * مختلفتين لليوم نفسه.
 */
async function findOpenDay(client, branchId) {
  const { rows } = await client.query(
    `select * from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0] || null;
}

async function closeBusinessDay(client, branchId, { closedBy = null, note = null } = {}) {
  const day = await findOpenDay(client, branchId);
  if (!day) return { error: "no_open_business_day" };

  const { rows: salesRows } = await client.query(
    `select count(*)::int as n, coalesce(sum(net_amount), 0) as sum
       from sales where branch_id = $1 and business_day_id = $2`,
    [branchId, day.id]
  );
  const { rows: expRows } = await client.query(
    `select coalesce(sum(amount), 0) as sum from expenses
       where branch_id = $1 and business_day_id = $2`,
    [branchId, day.id]
  );
  const { rows: purRows } = await client.query(
    `select coalesce(sum(grand_total), 0) as sum from purchases
       where branch_id = $1 and business_day_id = $2`,
    [branchId, day.id]
  );
  const { rows: cashRows } = await client.query(
    `select pool, coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
       from cash_tx where branch_id = $1 group by pool`,
    [branchId]
  );
  const byPool = new Map(cashRows.map((r) => [r.pool, Number(r.balance)]));
  const { rows: suspRows } = await client.query(
    `select count(*)::int as n, coalesce(sum(weight_est), 0) as w
       from scrap_items
      where branch_id = $1 and stage in ('pending_break','in_box','received')`,
    [branchId]
  );

  const { rows: updRows } = await client.query(
    `update business_days set
       status = 'closed', closed_by = $1, closed_at = now(), close_note = $2,
       sales_count = $3, sales_sum = $4, expenses_sum = $5, purchases_sum = $6,
       cash_at_close = $7, safe_at_close = $8, custody_at_close = $9,
       suspended_scrap_count = $10, suspended_scrap_weight = $11
     where id = $12
     returning *`,
    [
      closedBy, note,
      salesRows[0].n, roundMoney(salesRows[0].sum),
      roundMoney(expRows[0].sum), roundMoney(purRows[0].sum),
      roundMoney(byPool.get("daily") || 0), roundMoney(byPool.get("safe") || 0), roundMoney(byPool.get("custody") || 0),
      suspRows[0].n, roundWeight(suspRows[0].w),
      day.id,
    ]
  );

  return { day: updRows[0] };
}

export { closeBusinessDay, findOpenDay };
