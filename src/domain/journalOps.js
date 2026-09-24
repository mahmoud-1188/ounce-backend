import { roundMoney } from "./money.js";
import { postJournalEntry } from "./journal.js";
import { getOpenBusinessDay } from "./saleOps.js";

/**
 * عكس قيد وقيد التسوية اليدوي — تستعملهما الإدارة من لوحتها على دفاتر
 * الفرع (HqRemoteAccounts في المرجع). كلاهما يمرّ بـpostJournalEntry فيسري
 * عليه قفل الفترات وتوازن القاعدة.
 *
 * ⚠ لا يُعكس قيدٌ مرّتين، ولا يُعكس قيدُ عكس: عكسُ العكس يُعيد الأصل
 *   بقيدٍ ثالث ولا يُنبئ أحدًا بما حدث.
 */
async function reverseJournalEntry(client, branchId, entryId, { reason, createdBy = null, actorName = "" }) {
  const why = String(reason || "").trim();
  if (!why) return { error: "reversal_reason_required" };
  const { rows } = await client.query(
    "select * from journal_entries where id = $1 and branch_id = $2 for update",
    [entryId, branchId]
  );
  const e = rows[0];
  if (!e) return { error: "entry_not_found" };
  if (e.reversed_of) return { error: "cannot_reverse_reversal" };
  const { rows: done } = await client.query("select 1 from journal_entries where reversed_of = $1", [e.id]);
  if (done.length) return { error: "entry_already_reversed" };
  const { rows: lines } = await client.query("select account_code, side, amount from journal_lines where entry_id = $1", [e.id]);
  const day = await getOpenBusinessDay(client, branchId);
  const newId = await postJournalEntry(client, {
    branchId, businessDayId: day?.id || null, opType: e.op_type, refTable: e.ref_table, refId: e.ref_id,
    description: `عكس قيد ${String(e.id).slice(0, 8).toUpperCase()} — ${why}${actorName ? ` — ${actorName}` : ""}`,
    createdBy,
    lines: lines.map((l) => ({ account: l.account_code, side: l.side === "debit" ? "credit" : "debit", amount: Number(l.amount) })),
  });
  await client.query("update journal_entries set reversed_of = $1 where id = $2", [e.id, newId]);
  return { entryId: newId, ref: String(newId).slice(0, 8).toUpperCase(), reversedRef: String(e.id).slice(0, 8).toUpperCase() };
}

/** قيد تسوية يدوي بأسطر مدين/دائن — لا على حساب مجموعة، ومتوازن. */
async function postManualAdjustment(client, branchId, { lines = [], note, createdBy = null, actorName = "", refTable = null, refId = null }) {
  const text = String(note || "").trim();
  if (!text) return { error: "adjustment_note_required" };
  const { rows: accts } = await client.query("select code, is_group from accounts");
  const known = new Map(accts.map((a) => [a.code, a]));
  const out = [];
  for (const l of lines) {
    const acc = known.get(String(l.account || ""));
    if (!acc || acc.is_group) return { error: "invalid_account", account: l.account };
    const d = roundMoney(l.debit), c = roundMoney(l.credit);
    if (d < 0 || c < 0 || (d > 0 && c > 0)) return { error: "invalid_line", account: l.account };
    if (d > 0) out.push({ account: acc.code, side: "debit", amount: d });
    if (c > 0) out.push({ account: acc.code, side: "credit", amount: c });
  }
  const dr = roundMoney(out.filter((l) => l.side === "debit").reduce((a, l) => a + l.amount, 0));
  const cr = roundMoney(out.filter((l) => l.side === "credit").reduce((a, l) => a + l.amount, 0));
  if (out.length < 2 || Math.abs(dr - cr) > 0.005) return { error: "adjustment_unbalanced", debit: dr, credit: cr };
  const day = await getOpenBusinessDay(client, branchId);
  const entryId = await postJournalEntry(client, {
    branchId, businessDayId: day?.id || null, opType: "manual_adjustment", refTable, refId,
    description: `${text}${actorName ? ` — ${actorName}` : ""}`, createdBy, lines: out,
  });
  return { entryId, ref: String(entryId).slice(0, 8).toUpperCase(), debit: dr, credit: cr };
}

export { reverseJournalEntry, postManualAdjustment };
