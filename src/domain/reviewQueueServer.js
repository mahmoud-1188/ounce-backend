import { roundMoney } from "./money.js";
import { roundWeight } from "./weight.js";

/**
 * طابور المراجعة المحاسبية من الخادم — نظير buildReviewQueue في الواجهة
 * بالمفاتيح والبصمات نفسها (kind:id)، فحكمٌ تُصدره الإدارة من لوحتها يراه
 * الفرع على البند ذاته ويُخرجه من طابوره، والعكس.
 *
 * ⚠ فروقات الجرد ليست هنا: الجرد يُحفظ في الفرع — تُراجَع من شاشته.
 */
const LABELS = {
  sale_no_journal: { label: "فاتورة بلا قيد", severity: "block", page: "salesHistory" },
  expense_no_journal: { label: "مصروف بلا قيد", severity: "block", page: "expenses" },
  negative_cash: { label: "نقد سالب في الأستاذ", severity: "block", page: "generalLedger" },
  approval_pending: { label: "اعتماد معلّق", severity: "warn", page: "approvals" },
  day_stale: { label: "يوم مفتوح من يوم سابق", severity: "warn", page: "workday" },
  lot_no_invoice: { label: "شراء آجل بلا فاتورة", severity: "info", page: "purchases" },
};
const ORDER = { block: 0, warn: 1, info: 2 };

// ⚠ البصمة بصيغة reviewFingerprint في الواجهة حرفيًّا — وإلا بدا كل بندٍ
//   اعتمدته الإدارة «تغيّر بعد اعتماده» في الفرع.
const fingerprint = (t) => [t.amount != null ? Math.round((Number(t.amount) || 0) * 100) : "", t.lines != null ? t.lines : "", t.reversed ? "r" : ""].join("|");

async function buildServerReviewQueue(client, branchId, { includeResolved = false } = {}) {
  const items = [];
  const push = (kind, id, ref, date, why, extra = {}) => {
    const d = LABELS[kind];
    items.push({ key: `${kind}:${id}`, kind, id: String(id), ref: ref || "—", date: date || null, label: d.label, severity: d.severity, page: d.page, why, ...extra });
  };
  const { rows: noJ } = await client.query(
    `select s.id, s.ref, s.date, s.total, s.payment_method,
            (select count(*)::int from sale_lines sl where sl.sale_id = s.id) as lines
       from sales s
      where s.branch_id = $1 and not exists (select 1 from journal_entries e where e.ref_table = 'sales' and e.ref_id = s.id)
      order by s.date desc limit 50`,
    [branchId]
  );
  noJ.forEach((s) => push("sale_no_journal", s.id, s.ref, s.date, `فاتورة ${roundMoney(s.total)} · ${s.payment_method || ""} — لا قيدَ لها`, { amount: roundMoney(s.total), lines: s.lines }));
  const { rows: noJE } = await client.query(
    `select x.id, x.ref, x.created_at, x.amount, x.name, x.category from expenses x
      where x.branch_id = $1 and x.amount > 0 and not exists (select 1 from journal_entries e where e.ref_table = 'expenses' and e.ref_id = x.id)
      order by x.created_at desc limit 50`,
    [branchId]
  );
  noJE.forEach((x) => push("expense_no_journal", x.id, x.ref, x.created_at, `مصروف ${roundMoney(x.amount)} — ${x.name || x.category || ""} — لا قيدَ له`, { amount: roundMoney(x.amount) }));
  const { rows: neg } = await client.query(
    `select l.account_code as code, sum(case when l.side = 'debit' then l.amount else -l.amount end) as bal
       from journal_lines l join journal_entries e on e.id = l.entry_id
      where e.branch_id = $1 and l.account_code in ('1110','1120','1130','1140','1150')
      group by 1 having sum(case when l.side = 'debit' then l.amount else -l.amount end) < -0.01`,
    [branchId]
  );
  neg.forEach((r) => push("negative_cash", r.code, r.code, null, `رصيد ${r.code} في الأستاذ ${roundMoney(r.bal)}`, { amount: Math.abs(roundMoney(r.bal)) }));
  const { rows: ap } = await client.query(
    `select a.id, a.ref, a.amount, a.requester_name, a.created_at, coalesce(r.label, a.rule_id) as label
       from approvals a left join approval_rules r on r.id = a.rule_id
      where a.branch_id = $1 and a.status = 'pending' order by a.created_at desc limit 30`,
    [branchId]
  );
  ap.forEach((a) => push("approval_pending", a.id, a.ref, a.created_at, `${a.label} ${roundMoney(a.amount)} — طلبه ${a.requester_name || ""}`, { amount: roundMoney(a.amount) }));
  const { rows: stale } = await client.query(
    `select id, ref, opened_at from business_days where branch_id = $1 and status = 'open' and opened_at::date < current_date`,
    [branchId]
  );
  stale.forEach((d) => push("day_stale", d.id, d.ref, d.opened_at, `فُتح ${d.opened_at.toISOString().slice(0, 10)} ولم يُقفل`));
  const { rows: lots } = await client.query(
    `select l.id, l.ref, l.date, l.weight, l.karat, l.total_cost from lots l join purchases p on p.id = l.purchase_id
      where l.branch_id = $1 and p.payment_method = 'deferred' and p.invoice_pending = true order by l.date desc limit 30`,
    [branchId]
  );
  lots.forEach((l) => push("lot_no_invoice", l.id, l.ref, l.date, `دفعة ${roundWeight(l.weight)} جم عيار ${l.karat} آجلة بلا فاتورة مورد مرفقة`, { amount: roundMoney(l.total_cost) }));

  // ما رُوجع: المعتمد يخرج ما لم تتغيّر بصمته، وما يحتاج تعديلًا يبقى موسومًا
  const { rows: revs } = await client.query(
    "select key, verdict, note, fingerprint, reviewer_name, reviewer_kind, created_at from reviews where branch_id = $1 order by created_at",
    [branchId]
  );
  const latest = new Map();
  revs.forEach((r) => latest.set(r.key, r));
  return items
    .map((it) => {
      const fp = fingerprint(it);
      const r = latest.get(it.key) || null;
      const changed = !!(r && r.verdict === "approved" && r.fingerprint && r.fingerprint !== fp);
      return { ...it, fingerprint: fp, changedSinceReview: changed,
        lastReview: r ? { verdict: r.verdict, note: r.note || "", reviewer: r.reviewer_name || "", byHq: r.reviewer_kind === "store", date: r.created_at } : null,
        resolved: !!(r && r.verdict === "approved" && !changed) };
    })
    .filter((it) => includeResolved || !it.resolved)
    .sort((a, b) => (ORDER[a.severity] - ORDER[b.severity]) || String(b.date || "").localeCompare(String(a.date || "")));
}

export { buildServerReviewQueue, fingerprint as reviewFingerprint };
