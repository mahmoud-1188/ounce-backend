import { roundMoney } from "./money.js";
import { roundWeight } from "./weight.js";

/**
 * المساعد المحاسبي — أدواتٌ تقرأ الدفاتر على الخادم (Function Calling).
 *
 * منقولٌ عن المرجع (ACCOUNTANT_AI_TOOLS · runAccountantTool · server/ai):
 * النموذج لا يرى الأرقام ليحفظها ولا يكتب SQL — يستدعي أداةً فتُنفَّذ هنا
 * استعلامًا ثابتًا بمعاملات على دفاتر الفرع نفسه (RLS)، في معاملةٍ للقراءة
 * فقط، وتعود نتيجتها حرفيّة. الوحيدة التي تكتب «اقتراح قيد» — مسودّةً في
 * ai_proposals لا تصير قيدًا إلا باعتماد مديرٍ أو محاسب.
 *
 * ⚠ على الخادم لا في المتصفح: الواجهة تحمل آخر 2000 قيد فقط، والمحاسب
 *   يسأل عن سنة. رقمٌ من بياناتٍ مقصوصة يبدو دقيقًا وهو ناقص.
 *
 * ⚠ أداتا الإدارة في المرجع (نظرة الفروع · مصروفاتها) لا تُعرضان هنا: هذا
 *   مساعد الفرع، والإدارة تقرأ فروعها من لوحتها.
 */

const ACCOUNTANT_AI_SYSTEM = `أنت «المساعد المحاسبي» داخل نظام أوقية لإدارة محلات الذهب. تخاطب محاسبًا محترفًا بالعربية.

قواعد الأرقام (لا تُخالَف):
1. لا تذكر أي رقمٍ مالي أو وزنٍ إلا إذا جاءك من نتيجة أداة في هذه المحادثة. إن لم تستدعِ الأداة فقل «سأجلبه» واستدعِها. لا تخمّن، لا تُقدّر، لا تُكمل من الذاكرة.
2. انقل الأرقام كما وردت بالهللة والملّي (مثل 12,345.67 ر.س · 123.456 جم). لا تقريب إلا إن طلبه المحاسب صراحةً، وحينها قل «مقرَّبًا».
3. كل جمعٍ أو طرحٍ تعرضه احسبه من نتائج الأدوات وبيّن مكوّناته (أ + ب = ج). إن اختلف رقمان من أداتين فقل ذلك ولا تُوفّق بينهما بنفسك.
4. المدّة مذكورةٌ مع كل رقم. الافتراضي: الشهر الجاري. إن لم تُحدَّد المدّة اسأل أو صرّح بافتراضك.

قواعد المحاسبة في هذا النظام:
- النظام دوريّ: لا قيد تكلفة عند البيع؛ تكلفة المبيعات = مخزون أوّل + مشتريات − مخزون آخر.
- التكلفة تكلفة الشراء وقتها؛ السعر العالمي للمقارنة. المرتجع بسعر فاتورته.
- دفتران: نقديّ (اليومية) ووزنيّ (الذهب بالجرام والصافي 24). لا تخلط الجرام بالريال.
- الشجرة: 1xxx أصول · 2xxx التزامات · 3xxx حقوق ملكية · 4xxx إيرادات · 5xxx تكلفة الذهب · 6xxx مصروفات.
- الشبكة تستقرّ في البنك؛ التحويل البنكي من رصيد الشبكة. عمولة البنك تُسوّى شهريًّا على 6500.

صلاحياتك: القراءة والاستعلام والتحليل والمراجعة والتوصية فقط. لا ترحّل، لا تعدّل، لا تحذف. إن احتاج الأمر قيدًا فاستعمل أداة «اقتراح قيد» التي تُنشئ مسودّةً يعتمدها المحاسب بنفسه — وقل له صراحةً إنها مسودّة تنتظر اعتماده.

الأسلوب: جوابٌ مباشر ثم التفصيل. جداول قصيرة حين تفيد. لا مقدّمات ولا اعتذارات. حين تجد خللًا (قيد مختلّ، رصيد سالب، فاتورة بلا قيد، اعتماد معلّق) قله أوّلًا وباسم المستند ورقمه.`;

const period = { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } };

const ACCOUNTANT_AI_TOOLS = [
  { name: "trial_balance", description: "ميزان المراجعة: لكل حساب مدين ودائن ورصيد للمدّة (بالعملة)", input_schema: { type: "object", properties: { ...period } } },
  { name: "account_ledger", description: "حركة حسابٍ واحد: القيود التي مسّته للمدّة برصيدٍ جارٍ", input_schema: { type: "object", properties: { code: { type: "string", description: "رمز الحساب مثل 1130" }, ...period, limit: { type: "integer" } }, required: ["code"] } },
  { name: "income_statement", description: "قائمة الدخل للمدّة: الإيرادات والتكلفة والمصروفات وصافي الربح", input_schema: { type: "object", properties: { ...period } } },
  { name: "sales_summary", description: "ملخّص المبيعات للمدّة: العدد والإجمالي والضريبة وطرق الدفع والبائعون", input_schema: { type: "object", properties: { ...period } } },
  { name: "expenses_by_account", description: "المصروفات بحسابها للمدّة (6xxx من اليومية)", input_schema: { type: "object", properties: { ...period } } },
  { name: "cash_position", description: "النقد الآن: الصندوق اليومي، الخزنة، الشبكة (البنك)، عهدة الكسر — والذهب صافيًا", input_schema: { type: "object", properties: {} } },
  { name: "inventory_summary", description: "المخزون الآن: القطع والوزن والصافي والتكلفة بحسب العيار والتصنيف", input_schema: { type: "object", properties: {} } },
  { name: "review_queue", description: "ما يحتاج نظر المحاسب: مستندات بلا قيد، أرصدة نقد سالبة، اعتمادات معلّقة، يوم مفتوح من يوم سابق، شراء آجل بلا فاتورة", input_schema: { type: "object", properties: {} } },
  { name: "search_journal", description: "بحث في اليومية بنصٍّ أو مرجع", input_schema: { type: "object", properties: { text: { type: "string" }, limit: { type: "integer" } }, required: ["text"] } },
  { name: "supplier_statement", description: "كشف حساب مورد (ذهبٌ صافٍ بالجرام وأجورٌ بالعملة) للمدّة برصيدٍ جارٍ", input_schema: { type: "object", properties: { name: { type: "string" }, ...period }, required: ["name"] } },
  { name: "propose_journal_entry", description: "اقتراح قيد تسوية كمسودّة يعتمدها المحاسب بنفسه — لا يُرحَّل شيء", input_schema: { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { account: { type: "string" }, debit: { type: "number" }, credit: { type: "number" } }, required: ["account"] } }, note: { type: "string" } }, required: ["lines", "note"] } },
];

const cap = (arr, n = 60) => (arr.length > n ? [...arr.slice(0, n), { _truncated: `و${arr.length - n} سطرًا آخر — ضيّق المدّة` }] : arr);
const n2 = (v) => roundMoney(Number(v) || 0);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

function rangeOf(input = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  return { from: isDate(input.from) ? input.from : `${today.slice(0, 7)}-01`, to: isDate(input.to) ? input.to : today };
}

/// أرصدة الحسابات للمدّة (مدين − دائن) — الأصل والعكس معًا فيتقاصّان
async function balances(client, branchId, from, to) {
  const { rows } = await client.query(
    `select l.account_code as code,
            coalesce(sum(case when l.side = 'debit' then l.amount end), 0) as debit,
            coalesce(sum(case when l.side = 'credit' then l.amount end), 0) as credit
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and e.created_at >= $2::date and e.created_at < ($3::date + 1)
      group by l.account_code`,
    [branchId, from, to]
  );
  return rows;
}

async function accountsMap(client) {
  const { rows } = await client.query("select code, name, parent_code, is_group from accounts");
  return new Map(rows.map((a) => [a.code, a]));
}

/// قائمة الدخل — منطق buildIncomeStatement في الواجهة حرفيًّا (دوريّ)
function incomeFrom(balRows, accts) {
  const bal = new Map(balRows.map((r) => [r.code, n2(Number(r.debit) - Number(r.credit))]));
  const of = (code) => bal.get(code) || 0;
  const childrenOf = (parent) => [...accts.values()].filter((a) => a.parent_code === parent && !a.is_group);
  const sum = (list) => n2(list.reduce((a, x) => a + x, 0));
  const discounts = of("4155");
  const revenue = n2(-sum(childrenOf("4100").filter((a) => a.code !== "4155").map((a) => of(a.code))));
  const netRevenue = n2(revenue - discounts);
  const purchases = sum(childrenOf("5100").filter((a) => !["5150", "5160", "5175", "5185"].includes(a.code)).map((a) => of(a.code)));
  const openStock = of("5150");
  const closeStock = n2(-of("5160"));
  const returns = n2(-of("5175") - of("5185"));
  const cogs = n2(openStock + purchases - closeStock - returns);
  const grossProfit = n2(netRevenue - cogs);
  const opex = [...accts.values()].filter((a) => a.code.startsWith("6") && !a.is_group)
    .map((a) => ({ code: a.code, name: a.name, amount: of(a.code) })).filter((x) => Math.abs(x.amount) > 0);
  const opexTotal = sum(opex.map((x) => x.amount));
  return { revenue, discounts, netRevenue, openStock, purchases, closeStock, returns, cogs, grossProfit, opex, opexTotal, netProfit: n2(grossProfit - opexTotal) };
}

async function runAccountantTool(client, branchId, name, input = {}, ctx = {}) {
  const { from, to } = rangeOf(input);
  if (name === "trial_balance") {
    const accts = await accountsMap(client);
    const rows = (await balances(client, branchId, from, to))
      .map((r) => ({ code: r.code, name: accts.get(r.code)?.name || r.code, debit: n2(r.debit), credit: n2(r.credit), balance: n2(Number(r.debit) - Number(r.credit)) }))
      .sort((a, b) => a.code.localeCompare(b.code));
    return { from, to, rows: cap(rows, 80), totalDebit: n2(rows.reduce((a, r) => a + r.debit, 0)), totalCredit: n2(rows.reduce((a, r) => a + r.credit, 0)) };
  }
  if (name === "account_ledger") {
    const code = String(input.code || "");
    const accts = await accountsMap(client);
    if (!accts.has(code)) return { error: "حساب غير موجود في الشجرة", code };
    const { rows } = await client.query(
      `select e.id, e.created_at, e.op_type, e.description, coalesce(pr.label, e.op_type) as label,
              case when l.side = 'debit' then l.amount else 0 end as debit,
              case when l.side = 'credit' then l.amount else 0 end as credit
         from journal_lines l join journal_entries e on e.id = l.entry_id
         left join posting_rules pr on pr.op_type = e.op_type
        where e.branch_id = $1 and l.account_code = $2 and e.created_at < ($3::date + 1)
        order by e.created_at, e.id`,
      [branchId, code, to]
    );
    let bal = 0, opening = 0;
    const out = [];
    for (const r of rows) {
      bal = n2(bal + Number(r.debit) - Number(r.credit));
      if (String(r.created_at.toISOString()).slice(0, 10) < from) { opening = bal; continue; }
      out.push({ date: r.created_at.toISOString().slice(0, 10), ref: r.id.slice(0, 8).toUpperCase(), label: r.label, note: String(r.description || "").slice(0, 60), debit: n2(r.debit), credit: n2(r.credit), balance: bal });
    }
    const limit = Math.max(1, Math.min(200, Number(input.limit) || 60));
    return { account: code, name: accts.get(code).name, from, to, opening, rows: cap(out, limit), closingBalance: bal };
  }
  if (name === "income_statement") {
    const accts = await accountsMap(client);
    return { from, to, ...incomeFrom(await balances(client, branchId, from, to), accts), note: "النظام دوريّ: تكلفة المبيعات من قيود 5xxx (المخزون الأوّل والآخر من التسويات الجردية)" };
  }
  if (name === "sales_summary") {
    const args = [branchId, from, to];
    const where = "branch_id = $1 and date >= $2::date and date < ($3::date + 1)";
    const { rows: [t] } = await client.query(`select count(*)::int as count, coalesce(sum(total),0) as total, coalesce(sum(tax_amount),0) as tax from sales where ${where}`, args);
    const { rows: m } = await client.query(`select payment_method, count(*)::int as n, coalesce(sum(total),0) as total from sales where ${where} group by 1 order by 3 desc`, args);
    const { rows: s } = await client.query(`select coalesce(seller_name,'—') as seller, count(*)::int as n, coalesce(sum(total),0) as total from sales where ${where} group by 1 order by 3 desc`, args);
    const { rows: big } = await client.query(`select ref, date, total, customer_name from sales where ${where} order by total desc limit 5`, args);
    return { from, to, count: t.count, total: n2(t.total), tax: n2(t.tax),
      byMethod: m.map((r) => ({ method: r.payment_method, count: r.n, total: n2(r.total) })),
      bySeller: s.map((r) => ({ seller: r.seller, count: r.n, total: n2(r.total) })),
      largest: big.map((r) => ({ ref: r.ref, date: r.date.toISOString().slice(0, 10), total: n2(r.total), customer: r.customer_name || "" })) };
  }
  if (name === "expenses_by_account") {
    const accts = await accountsMap(client);
    const rows = (await balances(client, branchId, from, to)).filter((r) => r.code.startsWith("6"))
      .map((r) => ({ code: r.code, name: accts.get(r.code)?.name || r.code, amount: n2(Number(r.debit) - Number(r.credit)) }))
      .filter((r) => Math.abs(r.amount) > 0).sort((a, b) => b.amount - a.amount);
    return { from, to, rows, total: n2(rows.reduce((a, r) => a + r.amount, 0)) };
  }
  if (name === "cash_position") {
    const { rows } = await client.query(
      `select pool, method, coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
         from cash_tx where branch_id = $1 group by pool, method`,
      [branchId]
    );
    const get = (p, m) => n2(rows.filter((r) => r.pool === p && (!m || r.method === m)).reduce((a, r) => a + Number(r.balance), 0));
    const { rows: [inv] } = await client.query(
      `select coalesce(sum(i.weight * i.karat / 24.0), 0) as fine from item_units u join items i on i.id = u.item_id
        where i.branch_id = $1 and not u.sold and not u.issued`,
      [branchId]
    );
    return {
      drawer: { cash: get("daily", "cash"), network: get("daily", "network") },
      safe: { cash: get("safe", "cash"), network: get("safe", "network") },
      scrapCustody: { cash: get("custody") },
      goldFine24: { inventory: roundWeight(inv.fine) },
      note: "النقد من حركات الصناديق نفسها (cash_tx) — الشبكة في الخزنة تستقرّ في البنك",
    };
  }
  if (name === "inventory_summary") {
    const { rows } = await client.query(
      `select i.karat, coalesce(c.name, 'غير مصنَّف') as category, count(*)::int as pieces,
              coalesce(sum(i.weight), 0) as weight, coalesce(sum(i.weight * i.karat / 24.0), 0) as fine,
              coalesce(sum(i.weight * coalesce(i.cost_per_gram, 0) + coalesce(i.workmanship, 0)), 0) as cost
         from item_units u join items i on i.id = u.item_id left join categories c on c.id = i.category_id
        where i.branch_id = $1 and not u.sold and not u.issued
        group by i.karat, c.name order by i.karat desc, 2`,
      [branchId]
    );
    const byKarat = {}, byCategory = {};
    let pieces = 0, weight = 0, fine = 0, cost = 0;
    for (const r of rows) {
      const k = String(r.karat);
      byKarat[k] = byKarat[k] || { pieces: 0, weight: 0 };
      byKarat[k].pieces += r.pieces; byKarat[k].weight = roundWeight(byKarat[k].weight + Number(r.weight));
      byCategory[r.category] = byCategory[r.category] || { pieces: 0, weight: 0 };
      byCategory[r.category].pieces += r.pieces; byCategory[r.category].weight = roundWeight(byCategory[r.category].weight + Number(r.weight));
      pieces += r.pieces; weight += Number(r.weight); fine += Number(r.fine); cost += Number(r.cost);
    }
    return { pieces, weight: roundWeight(weight), fineWeight24: roundWeight(fine), costValue: n2(cost), byKarat, byCategory };
  }
  if (name === "review_queue") {
    const items = [];
    const { rows: noJ } = await client.query(
      `select s.ref, s.date, s.total from sales s
        where s.branch_id = $1 and not exists (select 1 from journal_entries e where e.ref_table = 'sales' and e.ref_id = s.id)
        order by s.date desc limit 30`,
      [branchId]
    );
    noJ.forEach((s) => items.push({ severity: "block", kind: "sale_no_journal", ref: s.ref, why: `فاتورة ${n2(s.total)} بلا قيد`, date: s.date }));
    const { rows: noJE } = await client.query(
      `select x.ref, x.created_at, x.amount from expenses x
        where x.branch_id = $1 and x.amount > 0 and not exists (select 1 from journal_entries e where e.ref_table = 'expenses' and e.ref_id = x.id)
        order by x.created_at desc limit 30`,
      [branchId]
    );
    noJE.forEach((x) => items.push({ severity: "block", kind: "expense_no_journal", ref: x.ref, why: `مصروف ${n2(x.amount)} بلا قيد`, date: x.created_at }));
    const { rows: neg } = await client.query(
      `select l.account_code as code, sum(case when l.side = 'debit' then l.amount else -l.amount end) as bal
         from journal_lines l join journal_entries e on e.id = l.entry_id
        where e.branch_id = $1 and l.account_code in ('1110','1120','1130','1140','1150')
        group by 1 having sum(case when l.side = 'debit' then l.amount else -l.amount end) < -0.01`,
      [branchId]
    );
    neg.forEach((r) => items.push({ severity: "block", kind: "negative_cash", ref: r.code, why: `رصيد ${r.code} في الأستاذ ${n2(r.bal)}` }));
    const { rows: ap } = await client.query(
      `select ref, amount, requester_name, rule_id from approvals where branch_id = $1 and status = 'pending' order by created_at desc limit 20`,
      [branchId]
    );
    ap.forEach((a) => items.push({ severity: "warn", kind: "approval_pending", ref: a.ref, why: `${a.rule_id} ${n2(a.amount)} — طلبه ${a.requester_name || "—"}` }));
    const { rows: stale } = await client.query(
      `select ref, opened_at from business_days where branch_id = $1 and status = 'open' and opened_at::date < current_date`,
      [branchId]
    );
    stale.forEach((d) => items.push({ severity: "warn", kind: "day_stale", ref: d.ref, why: `فُتح ${d.opened_at.toISOString().slice(0, 10)} ولم يُقفل` }));
    const { rows: lots } = await client.query(
      `select l.ref, l.weight, l.karat from lots l join purchases p on p.id = l.purchase_id
        where l.branch_id = $1 and p.payment_method = 'deferred' and p.invoice_pending = true order by l.date desc limit 20`,
      [branchId]
    );
    lots.forEach((l) => items.push({ severity: "info", kind: "lot_no_invoice", ref: l.ref, why: `دفعة ${roundWeight(l.weight)} جم عيار ${l.karat} آجلة بلا فاتورة مورد` }));
    return { count: items.length, items: cap(items, 40), note: "فروقات الجرد وأحكام المراجعة في شاشة المراجعة المحاسبية" };
  }
  if (name === "search_journal") {
    const q = String(input.text || "").trim();
    if (!q) return { error: "نصّ البحث فارغ" };
    const limit = Math.max(1, Math.min(60, Number(input.limit) || 30));
    const { rows } = await client.query(
      `select e.id, e.created_at, e.op_type, e.description, coalesce(pr.label, e.op_type) as label, e.reversed_of,
              (select json_agg(json_build_object('a', l.account_code, 's', l.side, 'v', l.amount)) from journal_lines l where l.entry_id = e.id) as lines
         from journal_entries e left join posting_rules pr on pr.op_type = e.op_type
        where e.branch_id = $1 and (e.description ilike $2 or e.op_type ilike $2 or pr.label ilike $2 or e.id::text ilike $3)
        order by e.created_at desc limit $4`,
      [branchId, `%${q}%`, `${q.toLowerCase()}%`, limit]
    );
    return { query: q, rows: rows.map((e) => ({
      date: e.created_at.toISOString().slice(0, 10), ref: e.id.slice(0, 8).toUpperCase(), label: e.label,
      note: String(e.description || "").slice(0, 80), isReversal: !!e.reversed_of,
      lines: (e.lines || []).map((l) => `${l.a} ${l.s === "debit" ? "مدين" : "دائن"} ${n2(l.v)}`),
    })) };
  }
  if (name === "supplier_statement") {
    const q = String(input.name || "").trim();
    const { rows: sups } = await client.query("select id, name from suppliers where branch_id = $1 order by name", [branchId]);
    const sup = sups.find((x) => x.name.includes(q)) || sups.find((x) => x.id === q);
    if (!sup) return { error: "مورد غير موجود", known: sups.map((x) => x.name).slice(0, 20) };
    const { rows } = await client.query(
      `select created_at, direction, gold_fine_grams, fees_amount, ref_table, note
         from supplier_ledger where branch_id = $1 and supplier_id = $2 and created_at < ($3::date + 1)
        order by created_at`,
      [branchId, sup.id, to]
    );
    let g = 0, f = 0, og = 0, of = 0;
    const out = [];
    for (const r of rows) {
      const s = r.direction === "increase" ? 1 : -1;
      g = roundWeight(g + s * Number(r.gold_fine_grams)); f = n2(f + s * Number(r.fees_amount));
      if (r.created_at.toISOString().slice(0, 10) < from) { og = g; of = f; continue; }
      out.push({ date: r.created_at.toISOString().slice(0, 10), kind: r.ref_table, direction: r.direction === "increase" ? "له علينا" : "سداد",
        gram24: roundWeight(s * Number(r.gold_fine_grams)), fees: n2(s * Number(r.fees_amount)), runGram24: g, runFees: f, note: String(r.note || "").slice(0, 60) });
    }
    return { supplier: sup.name, from, to, opening: { gram24: og, fees: of }, closing: { gram24: g, fees: f }, rows: cap(out, 60),
      note: "الموجب = التزامٌ علينا للمورد (ذهبٌ صافٍ بالجرام وأجورٌ بالعملة)" };
  }
  if (name === "propose_journal_entry") {
    const accts = await accountsMap(client);
    const lines = (Array.isArray(input.lines) ? input.lines : []).map((l) => ({ account: String(l.account || ""), debit: n2(l.debit), credit: n2(l.credit) }))
      .filter((l) => l.debit > 0 || l.credit > 0);
    const dr = n2(lines.reduce((a, l) => a + l.debit, 0)), cr = n2(lines.reduce((a, l) => a + l.credit, 0));
    const invalid = lines.filter((l) => !accts.has(l.account) || accts.get(l.account).is_group || (l.debit > 0 && l.credit > 0)).map((l) => l.account);
    const balanced = lines.length >= 2 && Math.abs(dr - cr) < 0.005;
    const note = String(input.note || "").trim().slice(0, 300);
    const { rows } = await client.query(
      `insert into ai_proposals (branch_id, requested_by, requested_name, question, lines, note, total_debit, total_credit)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [branchId, ctx.userId || null, ctx.userName || null, String(ctx.question || "").slice(0, 500), JSON.stringify(lines), note, dr, cr]
    );
    return { draft: { id: rows[0].id, lines: lines.map((l) => ({ ...l, name: accts.get(l.account)?.name || l.account })), note, totalDebit: dr, totalCredit: cr, balanced, invalidAccounts: invalid },
      status: "مسودّة تنتظر اعتماد المحاسب — لم يُرحَّل شيء" };
  }
  return { error: `أداة غير معروفة: ${name}` };
}

function shapeProposal(p) {
  return {
    id: p.id, lines: p.lines || [], note: p.note || "", totalDebit: Number(p.total_debit), totalCredit: Number(p.total_credit),
    status: p.status, requestedBy: p.requested_name || "", question: p.question || "", createdAt: p.created_at,
    decidedBy: p.decided_name || null, decidedAt: p.decided_at || null, decisionNote: p.decision_note || "",
    journalEntryId: p.journal_entry_id || null, journalRef: p.journal_entry_id ? String(p.journal_entry_id).slice(0, 8).toUpperCase() : null,
  };
}

export { ACCOUNTANT_AI_SYSTEM, ACCOUNTANT_AI_TOOLS, runAccountantTool, shapeProposal, incomeFrom };
