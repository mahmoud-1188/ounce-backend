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

export { POOL_ACCOUNT, poolAccount, postPoolTransfer, poolBalance };
