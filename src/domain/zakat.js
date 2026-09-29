import { roundMoney } from "./money.js";

/**
 * الزكاة — دالّةٌ واحدة لكل موضعٍ يعرضها (المرجع 5.2.0: computeZakat).
 *
 * الوعاء = النقد والبنك + الذمم بالريال المرجوّة + الذهب المملوك بوزنه × سعر اليوم
 *        + مصنعيّة القطع المملوكة + ذهبٌ لنا عند الغير × سعر اليوم
 *        − الالتزامات المتداولة بالريال − ما علينا ذهبًا × سعر اليوم
 * 2.5٪ هجريًّا، و2.5777٪ ميلاديًّا.
 *
 * ⚠ تُحسب على الخادم من الأرصدة كاملة: الواجهة تحمل آخر 2000 قيد فقط،
 *   فحسابها هناك يُسقط أرصدة الفروع القائمة.
 */
const ZAKAT_RATE_HIJRI = 0.025;
const ZAKAT_RATE_GREGORIAN = 0.025 * 365 / 354;
const ZAKAT_CASH_CODES = ["1110", "1120", "1130", "1140", "1150", "1160", "1170"];
const ZAKAT_RECEIVABLE_CODES = ["1310", "1315", "1320", "1340", "1350", "1360", "2350"];
const ZAKAT_GOLD_RECV_CODES = ["1320", "1340", "1350"];
const ZAKAT_DOUBTFUL_CODE = "1195";
const GOLD_WORKED = ["1210", "1246", "1290"];
const GOLD_UNWORKED = ["1220", "1225", "1230", "1240"];
const GOLD_OWED_CODES = ["2110", "2130", "2420"];
const ZAKAT_LIAB_EXCLUDE = ["2227", "2330", ...GOLD_OWED_CODES];

const toH = (x) => Math.round((Number(x) || 0) * 100);
const fromH = (h) => h / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;

/** مدخلات الزكاة من دفاتر الفرع حتى نهاية يوم `asOf` (أو الآن) — بلا سعر. */
async function zakatInputs(client, branchId, asOf = null) {
  const day = asOf ? String(asOf).slice(0, 10) : null;
  const until = day ? `${day}T23:59:59.999Z` : null;

  const { rows: accRows } = await client.query("select code, parent_code, unit, is_group from accounts");
  const byCode = new Map(accRows.map((a) => [a.code, a]));
  const under = (code, top) => {
    let a = byCode.get(code), n = 0;
    while (a && n++ < 12) { if (a.code === top) return true; a = a.parent_code ? byCode.get(a.parent_code) : null; }
    return false;
  };
  const rootOf = (code) => {
    let a = byCode.get(code), n = 0;
    while (a && a.parent_code && n++ < 12) a = byCode.get(a.parent_code);
    const r = a ? a.code : String(code);
    return /^\d000$/.test(r) ? r : `${r[0]}000`;
  };

  const { rows: balRows } = await client.query(
    `select l.account_code as code,
            sum(case when l.side = 'debit' then l.amount else -l.amount end) as bal
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and ($2::timestamptz is null or e.created_at <= $2)
      group by l.account_code`,
    [branchId, until]
  );
  const bal = Object.fromEntries(balRows.map((r) => [r.code, toH(r.bal)]));

  const cashH = ZAKAT_CASH_CODES.reduce((a, k) => a + (bal[k] || 0), 0);
  const recvGross = ZAKAT_RECEIVABLE_CODES.reduce((a, k) => a + Math.max(0, bal[k] || 0), 0);
  const doubtful = Math.max(0, -(bal[ZAKAT_DOUBTFUL_CODE] || 0));
  const recvH = Math.max(0, recvGross - doubtful);
  const liabH = Object.keys(bal)
    .filter((k) => rootOf(k) === "2000" && !under(k, "2500") && !ZAKAT_LIAB_EXCLUDE.includes(k))
    .reduce((a, k) => a + Math.max(0, -(bal[k] || 0)), 0);

  // الذهب بالوزن (معادل 24) لكل حساب — الوارد موجب والصادر سالب
  const { rows: goldRows } = await client.query(
    `select acct, sum(fine) as fine from (
        select to_account as acct, fine_weight as fine from gold_ledger_entries
         where branch_id = $1 and to_account is not null and ($2::timestamptz is null or created_at <= $2)
        union all
        select from_account, -fine_weight from gold_ledger_entries
         where branch_id = $1 and from_account is not null and ($2::timestamptz is null or created_at <= $2)
      ) t group by acct`,
    [branchId, until]
  );
  const fineOf = Object.fromEntries(goldRows.map((r) => [r.acct, Number(r.fine) || 0]));
  const worked = GOLD_WORKED.reduce((a, k) => a + (fineOf[k] || 0), 0);
  const unworked = GOLD_UNWORKED.reduce((a, k) => a + (fineOf[k] || 0), 0);
  // الذمم والالتزامات الذهبية حسابًا حسابًا: التزامٌ ذهبيٌّ برصيدٍ مدين (ذهبٌ لنا عند المورد) ذمّة،
  //   وذمّةٌ ذهبيةٌ برصيدٍ دائن التزام — لا يُقصّ المجموع صفرًا فيسقط ما لنا.
  const recvCodes = new Set([
    ...ZAKAT_GOLD_RECV_CODES,
    ...accRows.filter((a) => !a.is_group && a.unit && a.unit !== "currency" && a.code !== "1300" && under(a.code, "1300")).map((a) => a.code),
  ].filter((c) => !GOLD_WORKED.includes(c) && !GOLD_UNWORKED.includes(c) && !GOLD_OWED_CODES.includes(c)));
  let recvFine = 0, owedFine = 0;
  for (const code of [...GOLD_OWED_CODES, ...recvCodes]) {
    const v = fineOf[code] || 0;
    if (v > 0) recvFine += v; else owedFine -= v;
  }

  // مصنعيّة القطع المملوكة يوم الحساب (غير المباعة، والمعلّقة منها) — بلا أحجار
  const { rows: wkRows } = await client.query(
    `select coalesce(sum(i.workmanship), 0) as amount, count(*)::int as pieces
       from item_units u join items i on i.id = u.item_id
      where i.branch_id = $1 and u.sold = false and (u.issued = false or u.held = true)
        and ($2::timestamptz is null or i.date_added <= $2)`,
    [branchId, until]
  );

  return {
    v: 1, asOf: day,
    cash: fromH(cashH), receivables: fromH(recvH), doubtful: fromH(doubtful), liabilities: fromH(liabH),
    workedFine: r3(worked), unworkedFine: r3(unworked), goldFine: r3(Math.max(0, worked + unworked)),
    goldRecvFine: r3(recvFine), goldOwedFine: r3(owedFine),
    workmanship: roundMoney(wkRows[0].amount), pieces: wkRows[0].pieces,
  };
}

/** الزكاة بالسعر والسنة من المدخلات — نقيّة، بالهللة. */
function computeZakat(x, { price24 = 0, year = "gregorian" } = {}) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const p = Math.max(0, num(price24));
  const goldFine = Math.max(0, num(x.goldFine)), recvFine = Math.max(0, num(x.goldRecvFine)), owedFine = Math.max(0, num(x.goldOwedFine));
  const goldH = toH(goldFine * p), recvGoldH = toH(recvFine * p), owedH = toH(owedFine * p);
  const cashH = toH(x.cash), recvH = toH(Math.max(0, num(x.receivables))), liabH = toH(Math.max(0, num(x.liabilities)));
  const wkH = toH(Math.max(0, num(x.workmanship)));
  const baseH = Math.max(0, cashH + recvH + goldH + wkH + recvGoldH - liabH - owedH);
  const rate = year === "hijri" ? ZAKAT_RATE_HIJRI : ZAKAT_RATE_GREGORIAN;
  return {
    asOf: x.asOf || null, year: year === "hijri" ? "hijri" : "gregorian", rate, price24: p,
    noPrice: !(p > 0) && (goldFine > 0 || recvFine > 0 || owedFine > 0),
    cash: fromH(cashH), receivables: fromH(recvH), doubtful: Math.max(0, num(x.doubtful)),
    workedFine: num(x.workedFine), unworkedFine: num(x.unworkedFine), goldFine, goldValue: fromH(goldH),
    workmanship: fromH(wkH), pieces: Math.max(0, Math.round(num(x.pieces))),
    goldRecvFine: recvFine, goldRecvValue: fromH(recvGoldH),
    liabilities: fromH(liabH), goldOwedFine: owedFine, goldOwedValue: fromH(owedH),
    base: fromH(baseH), due: fromH(Math.round(baseH * rate)),
  };
}

export { ZAKAT_RATE_HIJRI, ZAKAT_RATE_GREGORIAN, zakatInputs, computeZakat };
