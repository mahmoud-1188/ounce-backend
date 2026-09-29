import { postJournalEntry } from "./journal.js";
import { roundMoney } from "./money.js";

/**
 * حساب كل صندوق في الشجرة — الصناديق في cash_tx (safe/daily/custody × cash/network)
 * والأستاذ في journal_lines؛ كل تحويلٍ بينها يجب أن يظهر في الاثنين.
 */
const POOL_ACCOUNT = {
  safe: { cash: "1110", network: "1120" },
  daily: { cash: "1130", network: "1140" },
  custody: { cash: "1150", network: "1150" },
};

const poolAccount = (pool, method) => POOL_ACCOUNT[pool]?.[method === "network" ? "network" : "cash"] || null;

/**
 * قيد التحويل بين صندوقين (المرجع 5.2.0: float_in/float_out) — مدين الوجهة ودائن
 * المصدر. مرجعه سطر الخروج في cash_tx فلا يتكرّر عند ترحيل القديم (044).
 * صندوقان على حسابٍ واحد (عهدة نقد ↔ عهدة شبكة) لا قيد لهما.
 */
async function postPoolTransfer(client, { branchId, businessDayId = null, from, to, method, amount, outTxId, description, createdBy = null }) {
  const amt = roundMoney(amount);
  const fromAcc = poolAccount(from, method);
  const toAcc = poolAccount(to, method);
  if (!(amt > 0) || !fromAcc || !toAcc || fromAcc === toAcc) return null;
  return postJournalEntry(client, {
    branchId, businessDayId, opType: "pool_transfer", refTable: "cash_tx", refId: outTxId,
    description: description || "تحويل بين الصناديق", createdBy,
    lines: [{ account: toAcc, side: "debit", amount: amt }, { account: fromAcc, side: "credit", amount: amt }],
  });
}

/** رصيد صندوقٍ واحد من حركاته. */
async function poolBalance(client, branchId, pool, method) {
  const { rows } = await client.query(
    `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as b
       from cash_tx where branch_id = $1 and pool = $2 and method = $3`,
    [branchId, pool, method]
  );
  return roundMoney(rows[0].b);
}

/**
 * ما يُغطّى من شبكة الخزنة قبل ردّ شبكةٍ من الصندوق اليومي: الزائد على رصيد
 * شبكة اليوم (صفرٌ إن كفى). بالهللة لا بالكسور، والرصيد السالب القديم لا
 * يُضاعف التغطية. (المرجع 5.2.0: networkRefundCover — قرار المالك 2026-09-29)
 */
function networkRefundCover(dailyNetwork, amount) {
  const have = Math.max(0, Math.round((Number(dailyNetwork) || 0) * 100));
  const need = Math.round((Number(amount) || 0) * 100);
  return need > have ? (need - have) / 100 : 0;
}

/**
 * ⚠ ردّ الشبكة يخرج من شبكة الصندوق اليومي (1140) — الحساب نفسه الذي يُقيَّد
 * عليه بيع الشبكة — لا من شبكة الخزنة (1120). وما زاد على رصيد شبكة اليوم
 * (ردٌّ بعد التوريد) يُحوَّل أوّلًا من شبكة الخزنة (1140 من 1120) في المعاملة
 * نفسها فلا يصير الصندوق سالبًا. يُرجع مبلغ التغطية وقيدها (أو صفرًا).
 */
async function coverDailyNetworkRefund(client, { branchId, businessDayId = null, amount, note, createdBy = null }) {
  const balance = await poolBalance(client, branchId, "daily", "network");
  const cover = networkRefundCover(balance, amount);
  if (!(cover > 0)) return { cover: 0, journalEntryId: null };
  const { rows } = await client.query(
    `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
     values ($1,$2,'safe','network','out',$3,'transfer_to_daily',$4,$5) returning id`,
    [branchId, businessDayId, cover, note, createdBy]
  );
  const journalEntryId = await postPoolTransfer(client, {
    branchId, businessDayId, from: "safe", to: "daily", method: "network",
    amount: cover, outTxId: rows[0].id, description: note, createdBy,
  });
  await client.query(
    `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
     values ($1,$2,'daily','network','in',$3,'transfer_from_safe',$4,$5)`,
    [branchId, businessDayId, cover, note, createdBy]
  );
  return { cover, journalEntryId };
}

export { POOL_ACCOUNT, poolAccount, postPoolTransfer, poolBalance, networkRefundCover, coverDailyNetworkRefund };
