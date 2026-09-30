// الجسر بين الدفترين (المرجع 5.2.0: buildIfrsBridge — IFRS 18، مطابقة مقياس الإدارة بالنتيجة الدولية)
// وقياس نهاية الفترة (IAS 2: الأقل من التكلفة وصافي القيمة البيعية).
//
// مقياس الإدارة: «بدأتُ بكيلو وصرتُ كيلو ومئة جرام → مكسبي مئة جرام». المكسب بالوزن
// = تغيّر صافي الذهب المملوك − تدفّقات الملكية (أرصدة افتتاحية · بضاعةٌ بين الفروع والإدارة).
// والنتيجة الدولية من حسابات الدخل في الأستاذ. والجسر يشرح الفرق بينهما سطرًا سطرًا:
//   المكسب بالوزن × سعر الإقفال
// + أثر السعر على ذهب أول المدة
// + تغيّر صافي النقد والذمم (بعد تدفّقات الملكية)
// + تدفّقات الملكية غير النقدية
// − تغيّر الفرق بين قيمة الذهب بالسوق وقيمته الدفترية (IAS 2: التكلفة لا السوق)
// + تغيّر بقية البنود (أصول ثابتة · مقدّمات …)
// = النتيجة الدولية. والفرق صفرٌ حين يتّفق الدفتران — وغير الصفر خللٌ في الدفتر يُبحث.
//
// ⚠ كل شيء من الخادم ومن الدفاتر كاملة، لا من آخر ألفي قيدٍ في الواجهة.

import { roundMoney } from "./money.js";

// صافي الموقف الذهبي: ما في اليد وما لنا عند الغير (موجب) وما علينا ذهبًا (سالب بطبيعته)
const GOLD_WORKED = ["1210", "1246", "1290"];
const GOLD_UNWORKED = ["1220", "1225", "1230", "1240"];
const GOLD_RECV = ["1320", "1340", "1350"];
const GOLD_OWED = ["2110", "2130", "2420"];
const GOLD_POSITION = [...GOLD_WORKED, ...GOLD_UNWORKED, ...GOLD_RECV, ...GOLD_OWED];
// حسابات الذهب التي تُقاس بالتكلفة (IAS 2): المخزون المشغول وغير المشغول
const GOLD_STOCK = [...GOLD_WORKED, ...GOLD_UNWORKED];

/// حركاتٌ تغيّر المملوك ولا تُعدّ مكسبًا: أرصدةٌ افتتاحية، وبضاعةٌ بين الفروع والإدارة، ورأس مالٍ ذهبي
const isFlowOp = (op) => /^(opening|capital|branch_transfer|hq_transaction)/.test(String(op || ""));

const H = (v) => Math.round((Number(v) || 0) * 100);
const fromH = (h) => roundMoney(h / 100);
const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

/** صافي الموقف الذهبي وتدفّقات الملكية حتى لحظة (بمعادل 24) — `strict` تعني قبلها لا حتى نهايتها. */
async function goldPositionAt(client, branchId, at, strict = false) {
  const cmp = strict ? "<" : "<=";
  const { rows } = await client.query(
    `select coalesce(sum(v), 0) as owned, coalesce(sum(case when flow then v else 0 end), 0) as flows from (
        select fine_weight as v, op_type ~ '^(opening|capital|branch_transfer|hq_transaction)' as flow
          from gold_ledger_entries
         where branch_id = $1 and to_account = any($2) and ($3::timestamptz is null or created_at ${cmp} $3)
        union all
        select -fine_weight, op_type ~ '^(opening|capital|branch_transfer|hq_transaction)'
          from gold_ledger_entries
         where branch_id = $1 and from_account = any($2) and ($3::timestamptz is null or created_at ${cmp} $3)
      ) t`,
    [branchId, GOLD_POSITION, at]
  );
  return { owned: Number(rows[0].owned) || 0, flows: Number(rows[0].flows) || 0 };
}

/** أرصدة الأستاذ بالهللة حتى لحظة. */
async function balancesAt(client, branchId, at, strict = false) {
  const cmp = strict ? "<" : "<=";
  const { rows } = await client.query(
    `select l.account_code as code,
            sum(case when l.side = 'debit' then l.amount else -l.amount end) as bal
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and ($2::timestamptz is null or e.created_at ${cmp} $2)
      group by l.account_code`,
    [branchId, at]
  );
  return Object.fromEntries(rows.map((r) => [r.code, H(r.bal)]));
}

/**
 * الجسر لمدّة [from, to]. `from` فارغٌ = منذ البداية. السعران لجرام 24؛ سعر أول المدة
 * يساوي سعر الإقفال إن لم يُعطَ (فلا أثر سعر).
 */
async function ifrsBridge(client, branchId, { from = null, to = null, priceOpen = 0, priceClose = 0 } = {}) {
  const Pc = Number(priceClose) || 0;
  const Po = Number(priceOpen) || Pc;
  const end = to || null;

  const { rows: accRows } = await client.query("select code, unit, statement, is_group from accounts");
  const acc = accRows.filter((a) => !a.is_group);
  const bsCodes = acc.filter((a) => a.statement === "balance").map((a) => a.code);
  const eqCodes = new Set(bsCodes.filter((c) => c.startsWith("3")));
  const goldSet = new Set(GOLD_POSITION);
  const naCodes = bsCodes.filter((c) => !eqCodes.has(c));
  const moneyCodes = new Set(acc.filter((a) => a.statement === "balance" && a.unit === "currency" && /^[12]/.test(a.code) && !goldSet.has(a.code)).map((a) => a.code));
  const incomeCodes = new Set(acc.filter((a) => a.statement === "income").map((a) => a.code));

  const b1 = await balancesAt(client, branchId, end);
  const b0 = from ? await balancesAt(client, branchId, from, true) : {};
  const part = (b, pred) => naCodes.filter(pred).reduce((a, c) => a + (b[c] || 0), 0);
  const NA1 = part(b1, () => true), NA0 = part(b0, () => true);
  const M1 = part(b1, (c) => moneyCodes.has(c)), M0 = part(b0, (c) => moneyCodes.has(c));
  const G1 = part(b1, (c) => goldSet.has(c)), G0 = part(b0, (c) => goldSet.has(c));
  const O1 = NA1 - M1 - G1, O0 = NA0 - M0 - G0;

  const s1 = await goldPositionAt(client, branchId, end);
  const s0 = from ? await goldPositionAt(client, branchId, from, true) : { owned: 0, flows: 0 };
  const W1 = s1.owned, W0 = s0.owned;
  const goldFlows = s1.flows - s0.flows;
  const gainFine = r3((W1 - W0) - goldFlows);

  // النتيجة الدولية من حسابات الدخل (بلا قيود الإقفال التي تنقلها إلى الأرباح المحتجزة)،
  // وتدفّقات الملكية النقدية: كل قيدٍ يمسّ حقوق الملكية
  const { rows: lines } = await client.query(
    `select e.id, l.account_code as code, case when l.side = 'debit' then l.amount else -l.amount end as d
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and e.op_type is distinct from 'year_close'
        and ($2::timestamptz is null or e.created_at >= $2) and ($3::timestamptz is null or e.created_at <= $3)`,
    [branchId, from, end]
  );
  const touchesEq = new Set(lines.filter((l) => eqCodes.has(l.code)).map((l) => l.id));
  let plH = 0, eqH = 0, moneyFlowH = 0;
  for (const l of lines) {
    const d = H(l.d);
    if (incomeCodes.has(l.code)) plH -= d;
    if (eqCodes.has(l.code)) eqH -= d;
    if (touchesEq.has(l.id) && moneyCodes.has(l.code)) moneyFlowH += d;
  }
  const U1 = H(W1 * Pc) - G1, U0 = H(W0 * Po) - G0;

  const out = [];
  const push = (key, label, h, hint) => out.push({ key, label, amount: fromH(h), hint });
  push("gain", "المكسب بالوزن × سعر الإقفال", H(gainFine * Pc), `${gainFine.toFixed(3)} جم24 × ${Pc}`);
  push("price", "أثر السعر على ذهب أول المدة", H(W0 * (Pc - Po)), `${r3(W0).toFixed(3)} جم24 × (${Pc} − ${Po})`);
  push("money", "تغيّر صافي النقد والذمم", (M1 - M0) - moneyFlowH, "النقد مبلغٌ لا مكسب — لكنه في النتيجة الدولية");
  push("owner", "تدفّقات الملكية غير النقدية", H(goldFlows * Pc) - (eqH - moneyFlowH), "أرصدةٌ افتتاحية · بضاعةٌ بين الفروع والإدارة · رأس مالٍ ذهبي");
  push("cost", "الفرق بين السوق والتكلفة (IAS 2)", -(U1 - U0), "ارتفاع السعر لا يُعدّ ربحًا حتى يُباع");
  push("other", "بقية البنود (أصول ثابتة · مقدّمات …)", O1 - O0, "");
  const sum = out.reduce((a, x) => a + H(x.amount), 0);
  return {
    from, to: end, priceOpen: Po, priceClose: Pc,
    gainFine, ownedOpen: r3(W0), ownedClose: r3(W1), goldFlows: r3(goldFlows),
    lines: out,
    total: fromH(sum),
    ifrsProfit: fromH(plH),
    difference: fromH(plH - sum),
    reconciles: Math.abs(plH - sum) < 100,
    unrealized: { open: fromH(U0), close: fromH(U1) },
  };
}

/**
 * قياس نهاية الفترة (IAS 2): لكل حساب ذهبٍ مخزونيّ وزنه وقيمته الدفترية وتكلفة جرامه وقيمته بالسوق،
 * والتخفيض المقترح حين تزيد التكلفة على السوق. عرضٌ فقط — لا يُكتب منه قيد.
 */
async function ifrsMeasurement(client, branchId, { asOf = null, price24 = 0 } = {}) {
  const P = Number(price24) || 0;
  const bal = await balancesAt(client, branchId, asOf);
  const { rows } = await client.query(
    `select acct, sum(v) as fine from (
        select to_account as acct, fine_weight as v from gold_ledger_entries
         where branch_id = $1 and to_account = any($2) and ($3::timestamptz is null or created_at <= $3)
        union all
        select from_account, -fine_weight from gold_ledger_entries
         where branch_id = $1 and from_account = any($2) and ($3::timestamptz is null or created_at <= $3)
      ) t group by acct`,
    [branchId, GOLD_STOCK, asOf]
  );
  const fineOf = Object.fromEntries(rows.map((r) => [r.acct, Number(r.fine) || 0]));
  const { rows: names } = await client.query("select code, name from accounts where code = any($1)", [GOLD_STOCK]);
  const nameOf = Object.fromEntries(names.map((r) => [r.code, r.name]));
  let writeDownH = 0, bookH = 0, marketH = 0;
  const out = GOLD_STOCK.map((code) => {
    const fine = r3(fineOf[code] || 0);
    const book = bal[code] || 0;
    const market = H(fine * P);
    const perGram = Math.abs(fine) > 0.0005 ? roundMoney(book / 100 / fine) : null;
    const wd = P > 0 && fine > 0 && book > market ? book - market : 0;
    writeDownH += wd; bookH += book; marketH += market;
    return { code, name: nameOf[code] || code, fine, book: fromH(book), perGram, market: fromH(market), writeDown: fromH(wd),
      // وزنٌ بلا قيمة أو قيمةٌ بلا وزن: الدفتران لا يتّفقان في هذا الحساب
      mismatch: (Math.abs(fine) < 0.0005) !== (Math.abs(book) < 1) };
  }).filter((r) => Math.abs(r.fine) >= 0.0005 || Math.abs(r.book) >= 0.01);
  return { asOf, price24: P, rows: out, book: fromH(bookH), market: fromH(marketH), writeDown: fromH(writeDownH) };
}

export { GOLD_POSITION, ifrsBridge, ifrsMeasurement, isFlowOp };
