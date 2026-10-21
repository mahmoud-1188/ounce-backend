import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { approvalGate } from "../domain/approvals.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { poolBalance } from "../domain/cashPools.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { nextItemRefNum, itemRefOf, insertUnit } from "../domain/itemCodes.js";

/**
 * الورشة كاملة (المرجع — migration 090):
 *   GET  /workshop/workshops                          الورش (موردون مُعلَّمون) بعقودها وأرصدتها
 *   POST /workshop/workshops/:supplierId              { workshop, allowPct, basis } — للمدير
 *   GET  /workshop/jobs
 *   POST /workshop/jobs                               { workshopId, karat, weighings:[{weight, evidence}], note }
 *   POST /workshop/jobs/:id/issues                    وزنةٌ إضافية على أمرٍ مفتوح
 *   POST /workshop/jobs/:id/receipts                  { pieces:[{weight, stonesWeight, categoryId}], filings, returned, feesPerGram, vatPct, price24, evidence }
 *   POST /workshop/jobs/:id/receipts/:rid/reverse     { reason }
 *   POST /workshop/jobs/:id/close                     { price24, decision: claim|writeoff, approvalId? }
 *   POST /workshop/jobs/:id/settle                    { kind: cash|return|writeoff|keep, price24, evidence, approvalId? }
 *   POST /workshop/pay-fees                           { workshopId, amount, method }
 * الصرف خامٌ من الخزنة (1220 ← 1250). الاستلام: كل قطعةٍ تُكوَّد فورًا في المخزون (1250 ← 1210)، والبرادة
 * صندوق الكسر (1250 ← 1230)، والمردود خامٌ للخزنة (1250 ← 1220). الهدر = الصافي المصروف − الصافي المستلم.
 * المسموح يُشطب (5350)، والزائد مطالبةٌ تبقى في «لدى الورش» حتى تُسوّى، أو يُشطب خسارةً (5360) باعتماد.
 * الأجور تُستحقّ عند الإقفال (5210 + 1360 ← 2120) وتُسدَّد من الخزنة.
 */
const router = Router();
router.use("/workshop", authenticate, requireAnyPage("scrapCustody", "inventory"));
const KARATS = [24, 22, 21, 18, 14];
const SCALE_STEP = 0.01;
const isManager = (auth) => auth.role === "manager" || auth.role === "owner";

function evidenceError(e, field) {
  if (!e || (e.source !== "scale" && e.source !== "manual")) return `${field}_evidence_required`;
  if (e.source === "manual" && String(e.reason || "").trim().length < 3) return `${field}_manual_reason_required`;
  return null;
}
const cleanEv = (e) => (e ? { source: e.source, raw: e.raw != null ? String(e.raw).slice(0, 60) : null, reason: e.reason ? String(e.reason).slice(0, 120) : null, at: new Date().toISOString() } : null);
const purityOf = (karat) => fineWeight(1, karat) || 1;
const liveReceipts = (j) => (j.receipts || []).filter((r) => !r.reversedAt);

// مجاميع الأمر بالصافي — نقيّة
function totalsOf(j) {
  const k = j.karat;
  const issued = roundWeight((j.issues || []).reduce((s, x) => s + Number(x.weight || 0), 0) || Number(j.issued_weight) || 0);
  let pieces = 0, filings = 0, returned = 0, fees = 0, vat = 0, count = 0;
  for (const r of liveReceipts(j)) {
    pieces += (r.pieces || []).reduce((s, p) => s + Number(p.net || 0), 0);
    count += (r.pieces || []).length;
    filings += Number(r.filings || 0);
    returned += Number(r.returned || 0);
    fees += Number(r.fees || 0);
    vat += Number(r.vat || 0);
  }
  return {
    issued, pieces: roundWeight(pieces), filings: roundWeight(filings), returned: roundWeight(returned), count,
    issuedFine: fineWeight(issued, k), outFine: fineWeight(pieces + filings, k), returnedFine: fineWeight(returned, k),
    fees: roundMoney(fees), vat: roundMoney(vat),
  };
}

// حسبة الهدر بالصافي — نقيّة. weighings = عدد الوزنات (ضجيج الميزان لكلٍّ منها)
function wastageOf({ karat, issued, worked, returned, pct, basis, weighings = 3 }) {
  const issuedFine = fineWeight(issued, karat), workedFine = fineWeight(worked, karat), returnedFine = fineWeight(returned, karat);
  const wastage = roundWeight(issuedFine - workedFine - returnedFine);
  const base = basis === "out" ? workedFine : issuedFine;
  const allowed = roundWeight(base * (Number(pct) || 0) / 100);
  const noise = roundWeight(fineWeight(SCALE_STEP * weighings, karat));
  return { wastage, allowed, noise, excess: roundWeight(Math.max(0, wastage - allowed - noise)), overReturn: wastage < -noise };
}

function calcOf(j) {
  const t = totalsOf(j);
  const weighings = (j.issues || []).length + liveReceipts(j).reduce((s, r) => s + (r.pieces || []).length + (r.filings > 0 ? 1 : 0) + (r.returned > 0 ? 1 : 0), 0);
  return { ...t, ...wastageOf({ karat: j.karat, issued: t.issued, worked: t.pieces + t.filings, returned: t.returned, pct: Number(j.allowed_pct), basis: j.basis, weighings: Math.max(1, weighings) }) };
}

const shape = (j) => ({
  id: j.id, ref: j.ref, workshopId: j.workshop_id, workshopName: j.workshop_name, karat: j.karat, issuedWeight: Number(j.issued_weight),
  allowedPct: Number(j.allowed_pct), basis: j.basis, status: j.status, issues: j.issues || [], receipts: j.receipts || [],
  fees: j.fees || {}, settlement: j.settlement || null, calc: calcOf(j),
  wastageFine: j.wastage_fine == null ? null : Number(j.wastage_fine), allowedFine: j.allowed_fine == null ? null : Number(j.allowed_fine),
  excessFine: j.excess_fine == null ? null : Number(j.excess_fine), price24: j.price24 == null ? null : Number(j.price24),
  evidence: j.evidence || {}, note: j.note || "", createdAt: j.created_at, receivedAt: j.received_at, closedAt: j.closed_at, approvalId: j.approval_id,
});

async function openDay(c, branchId) {
  const { rows } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [branchId]);
  return rows[0]?.id || null;
}
async function ledger(c, auth, dayId, { op, karat, weight, fine, from, to, refId, note }) {
  await c.query(
    `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'workshop_jobs',$9,$10,$11)`,
    [auth.branchId, dayId, op, karat, roundWeight(weight), fine ?? fineWeight(weight, karat), from, to, refId, note, auth.userId]);
}
async function safeRaw(c, branchId, karat) {
  const { rows } = await c.query(
    `select coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as w from safe_gold_tx
      where branch_id = $1 and karat = $2 and kind = 'raw'`, [branchId, karat]);
  return Number(rows[0].w) || 0;
}
async function safeTx(c, auth, dayId, { direction, karat, weight, note, refId }) {
  await c.query(
    `insert into safe_gold_tx (branch_id, business_day_id, direction, karat, weight, kind, destination, note, created_by, ref_table, ref_id)
     values ($1,$2,$3,$4,$5,'raw',$6,$7,$8,'workshop_jobs',$9)`,
    [auth.branchId, dayId, direction, karat, roundWeight(weight), direction === "out" ? "workshop" : null, note, auth.userId, refId]);
}
async function loadJob(c, auth, id) {
  const { rows } = await c.query("select * from workshop_jobs where id = $1 and branch_id = $2 for update", [id, auth.branchId]);
  return rows[0] || null;
}
// أجور الورشة المستحقّة عليها لنا (2120 دائن) من دفتر الموردين
async function feesOwed(c, branchId, supplierId) {
  const { rows } = await c.query(
    `select coalesce(sum(case when direction = 'increase' then fees_amount else -fees_amount end), 0) as f
       from supplier_ledger where branch_id = $1 and supplier_id = $2`, [branchId, supplierId]);
  return roundMoney(rows[0].f);
}
async function termsOf(c, branchId, supplier) {
  if (supplier?.workshop_terms?.allowPct != null) return { allowPct: Number(supplier.workshop_terms.allowPct), basis: supplier.workshop_terms.basis === "out" ? "out" : "in" };
  const { rows } = await c.query("select sale_prefs from branch_settings where branch_id = $1", [branchId]);
  return { allowPct: Number(rows[0]?.sale_prefs?.wastage?.defaultAllowPct) || 0, basis: "in" };
}
const reply = (res, out, created = false) => {
  if (out.approvalPending) return res.status(202).json(out);
  if (out.error) return res.status(out.error === "job_not_found" || out.error === "workshop_not_found" ? 404 : 409).json(out);
  res.status(created ? 201 : 200).json(out);
};

router.get("/workshop/workshops", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query(
      `select s.id, s.name, s.phone, s.workshop, s.workshop_terms,
              coalesce((select sum(case when l.direction = 'increase' then l.fees_amount else -l.fees_amount end) from supplier_ledger l
                         where l.branch_id = $1 and l.supplier_id = s.id), 0) as fees_owed,
              (select count(*)::int from workshop_jobs j where j.branch_id = $1 and j.workshop_id = s.id and j.status <> 'closed') as open_jobs
         from suppliers s where s.branch_id = $1 order by s.workshop desc, s.name`, [req.auth.branchId]));
    res.json({ workshops: rows.map((s) => ({
      id: s.id, name: s.name, phone: s.phone || "", workshop: !!s.workshop,
      allowPct: s.workshop_terms?.allowPct ?? null, basis: s.workshop_terms?.basis || "in",
      feesOwed: roundMoney(s.fees_owed), openJobs: s.open_jobs,
    })) });
  } catch (err) { next(err); }
});

router.post("/workshop/workshops/:supplierId", async (req, res, next) => {
  if (!isManager(req.auth)) return res.status(403).json({ error: "manager_only" });
  const b = req.body || {};
  const pct = b.allowPct == null || b.allowPct === "" ? null : Math.max(0, Math.min(20, Number(b.allowPct) || 0));
  const terms = pct == null ? null : { allowPct: pct, basis: b.basis === "out" ? "out" : "in" };
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query(
      "update suppliers set workshop = $3, workshop_terms = $4 where id = $1 and branch_id = $2 returning id",
      [req.params.supplierId, req.auth.branchId, b.workshop !== false, terms ? JSON.stringify(terms) : null]));
    if (!rows[0]) return res.status(404).json({ error: "workshop_not_found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get("/workshop/jobs", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query(
      "select * from workshop_jobs where branch_id = $1 order by (status = 'closed'), created_at desc limit 200", [req.auth.branchId]));
    res.json({ jobs: rows.map(shape) });
  } catch (err) { next(err); }
});

// وزنات الصرف: كل وزنةٍ بدليلها، ومجموعها لا يتجاوز خام الخزنة
function readWeighings(b) {
  const list = Array.isArray(b.weighings) ? b.weighings : (b.weight ? [{ weight: b.weight, evidence: b.evidence?.issued || b.evidence }] : []);
  const out = [];
  for (const w of list) {
    const weight = roundWeight(Number(w.weight));
    if (!(weight > 0)) return { error: "invalid_weight" };
    const e = evidenceError(w.evidence, "issued");
    if (e) return { error: e };
    out.push({ weight, evidence: cleanEv(w.evidence) });
  }
  if (!out.length) return { error: "invalid_weight" };
  return { list: out, total: roundWeight(out.reduce((s, x) => s + x.weight, 0)) };
}

async function issueGold(c, auth, j, list, total) {
  const available = await safeRaw(c, auth.branchId, j.karat);
  if (total > available + 0.0005) return { error: "insufficient_safe_gold", available, requested: total };
  const dayId = await openDay(c, auth.branchId);
  const label = `صرف للورشة ${j.workshop_name} — ${j.ref}`;
  await safeTx(c, auth, dayId, { direction: "out", karat: j.karat, weight: total, note: label, refId: j.id });
  await ledger(c, auth, dayId, { op: "workshop_issue", karat: j.karat, weight: total, from: "1220", to: "1250", refId: j.id, note: label });
  return null;
}

router.post("/workshop/jobs", async (req, res, next) => {
  const b = req.body || {};
  const karat = Number(b.karat);
  if (!KARATS.includes(karat)) return res.status(400).json({ error: "invalid_karat_or_weight" });
  const w = readWeighings(b);
  if (w.error) return res.status(400).json({ error: w.error });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      let supplier = null;
      if (b.workshopId) {
        const { rows } = await c.query("select * from suppliers where id = $1 and branch_id = $2", [b.workshopId, req.auth.branchId]);
        supplier = rows[0];
        if (!supplier) return { error: "workshop_not_found" };
      }
      const name = supplier?.name || String(b.workshopName || "").trim().slice(0, 80);
      if (!name) return { error: "workshop_required" };
      // شروط العقد من الورشة، وإلا النسبة الافتراضية من الإعدادات — المكتوب يدويًا للأوامر بلا ورشةٍ مسجّلة فقط
      const terms = supplier ? await termsOf(c, req.auth.branchId, supplier)
        : { allowPct: Math.max(0, Math.min(20, Number(b.allowedPct) || 0)), basis: b.basis === "out" ? "out" : "in" };
      const { rows: n } = await c.query("select count(*)::int + 1 as n from workshop_jobs where branch_id = $1", [req.auth.branchId]);
      const ref = `WSH-${String(n[0].n).padStart(5, "0")}`;
      const at = new Date().toISOString();
      const { rows } = await c.query(
        `insert into workshop_jobs (branch_id, ref, workshop_name, workshop_id, karat, issued_weight, allowed_pct, basis, issues, evidence, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [req.auth.branchId, ref, name, supplier?.id || null, karat, w.total, terms.allowPct, terms.basis,
         JSON.stringify(w.list.map((x) => ({ ...x, at, by: req.auth.userId }))), JSON.stringify({ issued: w.list[0].evidence }),
         String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      const err = await issueGold(c, req.auth, rows[0], w.list, w.total);
      if (err) { await c.query("delete from workshop_jobs where id = $1", [rows[0].id]); return err; }
      return { job: shape(rows[0]) };
    });
    reply(res, out, true);
  } catch (err) { next(err); }
});

router.post("/workshop/jobs/:id/issues", async (req, res, next) => {
  const w = readWeighings(req.body || {});
  if (w.error) return res.status(400).json({ error: w.error });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const j = await loadJob(c, req.auth, req.params.id);
      if (!j) return { error: "job_not_found" };
      if (j.status !== "open" && j.status !== "received") return { error: "job_not_open" };
      const err = await issueGold(c, req.auth, j, w.list, w.total);
      if (err) return err;
      const at = new Date().toISOString();
      const issues = [...(j.issues || []), ...w.list.map((x) => ({ ...x, at, by: req.auth.userId }))];
      const { rows } = await c.query("update workshop_jobs set issues = $2, issued_weight = issued_weight + $3 where id = $1 returning *",
        [j.id, JSON.stringify(issues), w.total]);
      return { job: shape(rows[0]) };
    });
    reply(res, out);
  } catch (err) { next(err); }
});

router.post("/workshop/jobs/:id/receipts", async (req, res, next) => {
  const b = req.body || {};
  const pieces = (Array.isArray(b.pieces) ? b.pieces : []).map((p) => ({
    weight: roundWeight(Number(p.weight)), stonesWeight: roundWeight(Number(p.stonesWeight) || 0), categoryId: p.categoryId || null,
  }));
  const filings = roundWeight(Number(b.filings) || 0), returned = roundWeight(Number(b.returned) || 0);
  const feesPerGram = Math.max(0, roundMoney(Number(b.feesPerGram) || 0));
  const vatPct = Math.max(0, Math.min(30, Number(b.vatPct) || 0));
  const price24 = Number(b.price24) || 0;
  if (pieces.some((p) => !(p.weight > 0) || p.stonesWeight >= p.weight)) return res.status(400).json({ error: "invalid_weights" });
  if (pieces.some((p) => !p.categoryId)) return res.status(400).json({ error: "category_required" });
  if (!(filings >= 0) || !(returned >= 0) || pieces.length + (filings > 0) + (returned > 0) === 0) return res.status(400).json({ error: "invalid_weights" });
  if (pieces.length > 200) return res.status(400).json({ error: "too_many_pieces" });
  if (pieces.length && !(price24 > 0)) return res.status(400).json({ error: "price_required" });
  const evErr = evidenceError(b.evidence, "received");
  if (evErr) return res.status(400).json({ error: evErr });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const j = await loadJob(c, req.auth, req.params.id);
      if (!j) return { error: "job_not_found" };
      if (j.status !== "open" && j.status !== "received") return { error: "job_not_open" };
      const k = j.karat;
      const dayId = await openDay(c, req.auth.branchId);
      const label = `استلام من الورشة ${j.workshop_name} — ${j.ref}`;
      const costPerGram = roundMoney(price24 * purityOf(k));
      const outPieces = [];
      let nextRef = pieces.length ? await nextItemRefNum(c, req.auth.branchId) : 0;
      for (const p of pieces) {
        const net = roundWeight(p.weight - p.stonesWeight);
        const ref = itemRefOf(nextRef++);
        const { rows: it } = await c.query(
          `insert into items (branch_id, ref, category_id, karat, weight, stones_weight, cost_per_gram, workmanship, lot_workmanship_share, from_scrap, business_day_id, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,0,false,$9,$10) returning id`,
          [req.auth.branchId, ref, p.categoryId, k, p.weight, p.stonesWeight, costPerGram, roundMoney(feesPerGram * net), dayId, req.auth.userId]);
        const unit = await insertUnit(c, it[0].id, ref);
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: k, weight: net, from: "1250", to: "1210", refId: j.id, note: `${label} — ${ref}` });
        outPieces.push({ itemId: it[0].id, unitId: unit.id, code: unit.code, weight: p.weight, stonesWeight: p.stonesWeight, net, categoryId: p.categoryId });
      }
      let scrapId = null, scrapRef = null;
      if (filings > 0) {
        const { rows: n } = await c.query("select count(*)::int + 1 as n from scrap_items where branch_id = $1", [req.auth.branchId]);
        scrapRef = `SCR-${String(n[0].n).padStart(6, "0")}`;
        const { rows: si } = await c.query(
          `insert into scrap_items (branch_id, ref, supplier_id, karat_est, weight_est, stage, source, description, total_paid, business_day_id, created_by)
           values ($1,$2,$3,$4,$5,'in_box','workshop',$6,0,$7,$8) returning id`,
          [req.auth.branchId, scrapRef, j.workshop_id, k, filings, `برادة ${j.ref}`, dayId, req.auth.userId]);
        scrapId = si[0].id;
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: k, weight: filings, from: "1250", to: "1230", refId: j.id, note: `${label} — برادة` });
      }
      if (returned > 0) {
        await safeTx(c, req.auth, dayId, { direction: "in", karat: k, weight: returned, note: `${label} — مردود`, refId: j.id });
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: k, weight: returned, from: "1250", to: "1220", refId: j.id, note: `${label} — مردود` });
      }
      const netPieces = outPieces.reduce((s, p) => s + p.net, 0);
      const fees = roundMoney(feesPerGram * netPieces), vat = roundMoney(fees * vatPct / 100);
      const receipt = {
        id: crypto.randomUUID(), at: new Date().toISOString(), by: req.auth.userId, pieces: outPieces, filings, scrapId, scrapRef, returned,
        feesPerGram, vatPct, fees, vat, price24: price24 || null, evidence: cleanEv(b.evidence),
      };
      const { rows } = await c.query(
        "update workshop_jobs set receipts = receipts || $2::jsonb, status = 'received', received_at = coalesce(received_at, now()) where id = $1 returning *",
        [j.id, JSON.stringify([receipt])]);
      return { job: shape(rows[0]), receipt };
    });
    reply(res, out, true);
  } catch (err) { next(err); }
});

// عكس استلامٍ خاطئ — قبل الإقفال، وما بِيع أو صُرف أو حُوِّل من قطعه أو كُسِّر من برادته لا يُعكس
router.post("/workshop/jobs/:id/receipts/:rid/reverse", async (req, res, next) => {
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  if (reason.length < 3) return res.status(400).json({ error: "reason_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const j = await loadJob(c, req.auth, req.params.id);
      if (!j) return { error: "job_not_found" };
      if (j.status !== "open" && j.status !== "received") return { error: "job_not_open" };
      const r = (j.receipts || []).find((x) => x.id === req.params.rid);
      if (!r || r.reversedAt) return { error: "receipt_not_found" };
      const unitIds = (r.pieces || []).map((p) => p.unitId);
      if (unitIds.length) {
        const { rows: busy } = await c.query(
          `select code from item_units where id = any($1::uuid[]) and (sold or issued or transfer_id is not null or held or sale_id is not null or reserved_for is not null)`, [unitIds]);
        if (busy.length) return { error: "receipt_pieces_used", codes: busy.map((x) => x.code) };
      }
      if (r.scrapId) {
        const { rows: s } = await c.query("select stage from scrap_items where id = $1", [r.scrapId]);
        if (s[0] && s[0].stage !== "in_box") return { error: "receipt_filings_used" };
      }
      const dayId = await openDay(c, req.auth.branchId);
      const label = `عكس استلام ${j.ref} — ${reason}`;
      for (const p of r.pieces || []) {
        await c.query("delete from item_units where id = $1", [p.unitId]);
        await c.query("delete from items where id = $1 and not exists (select 1 from item_units where item_id = $1)", [p.itemId]);
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: j.karat, weight: p.net, from: "1210", to: "1250", refId: j.id, note: `${label} — ${p.code}` });
      }
      if (r.scrapId) {
        await c.query("delete from scrap_items where id = $1", [r.scrapId]);
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: j.karat, weight: r.filings, from: "1230", to: "1250", refId: j.id, note: `${label} — برادة` });
      }
      if (r.returned > 0) {
        if (await safeRaw(c, req.auth.branchId, j.karat) + 0.0005 < r.returned) return { error: "insufficient_safe_gold" };
        await safeTx(c, req.auth, dayId, { direction: "out", karat: j.karat, weight: r.returned, note: label, refId: j.id });
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: j.karat, weight: r.returned, from: "1220", to: "1250", refId: j.id, note: label });
      }
      const receipts = (j.receipts || []).map((x) => (x.id === r.id ? { ...x, reversedAt: new Date().toISOString(), reversedBy: req.auth.userId, reverseReason: reason } : x));
      const live = receipts.filter((x) => !x.reversedAt).length;
      const { rows } = await c.query("update workshop_jobs set receipts = $2, status = $3 where id = $1 returning *",
        [j.id, JSON.stringify(receipts), live ? "received" : "open"]);
      return { job: shape(rows[0]) };
    });
    reply(res, out);
  } catch (err) { next(err); }
});

// قيد خسارة ذهبٍ لدى الورشة: يخرج من 1250 بوزنه وقيمته بسعر اليوم على حساب الخسارة
async function writeOffFine(c, auth, dayId, j, fine, price24, account, note) {
  if (!(fine > 0.0005)) return null;
  await ledger(c, auth, dayId, { op: "workshop_wastage", karat: j.karat, weight: fine / purityOf(j.karat), fine: roundWeight(fine), from: "1250", to: null, refId: j.id, note });
  const value = roundMoney(fine * price24);
  if (!(value > 0)) return null;
  return postJournalEntry(c, {
    branchId: auth.branchId, businessDayId: dayId, opType: "workshop_wastage", refTable: "workshop_jobs", refId: j.id,
    description: note, createdBy: auth.userId,
    lines: [{ account, side: "debit", amount: value }, { account: "1220", side: "credit", amount: value }],
  });
}

// استحقاق الأجور عند الإقفال: مدين 5210 (والمدخلات 1360) دائن 2120، ودفتر الورشة يزيد
async function accrueFees(c, auth, dayId, j, t) {
  if (!(t.fees + t.vat > 0)) return null;
  const id = await postJournalEntry(c, {
    branchId: auth.branchId, businessDayId: dayId, opType: "workshop_fees", refTable: "workshop_jobs", refId: j.id,
    description: `أجور الورشة ${j.workshop_name} — ${j.ref}`, createdBy: auth.userId,
    lines: [
      { account: "5210", side: "debit", amount: t.fees },
      { account: "1360", side: "debit", amount: t.vat },
      { account: "2120", side: "credit", amount: roundMoney(t.fees + t.vat) },
    ],
  });
  if (j.workshop_id) await c.query(
    `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, fees_amount, ref_table, ref_id, note, created_by)
     values ($1,$2,$3,'increase',$4,'workshop_jobs',$5,$6,$7)`,
    [auth.branchId, j.workshop_id, dayId, roundMoney(t.fees + t.vat), j.id, `أجور ${j.ref}`, auth.userId]);
  return id;
}

router.post("/workshop/jobs/:id/close", async (req, res, next) => {
  const b = req.body || {};
  const price24 = Number(b.price24) || 0;
  const decision = b.decision === "writeoff" ? "writeoff" : "claim";
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const j = await loadJob(c, req.auth, req.params.id);
      if (!j) return { error: "job_not_found" };
      if (j.status !== "received" && j.status !== "pending") return { error: j.status === "closed" ? "job_closed" : "nothing_received" };
      const t = calcOf(j);
      if (t.overReturn) return { error: "returned_more_than_issued", wastage: t.wastage };
      if (t.wastage > t.noise && !(price24 > 0)) return { error: "price_required" };
      const allowedPart = roundWeight(Math.max(0, Math.min(t.wastage, t.allowed + t.noise)));
      const excess = roundWeight(Math.max(0, t.wastage - allowedPart));
      if (excess > 0 && decision === "writeoff") {
        const gate = await approvalGate(c, req.auth, {
          kind: "workshop_wastage", amount: roundMoney(excess * price24), approvalId: b.approvalId || null,
          note: `شطب هدر الورشة ${j.workshop_name} (${j.ref}) فوق المسموح بـ${excess} جم صافٍ — المسموح ${t.allowed} جم`,
          payload: { jobId: j.id, action: "close", decision, price24 },
        });
        if (gate.error) return gate;
        if (gate.pending) {
          await c.query("update workshop_jobs set status = 'pending', approval_id = $2 where id = $1", [j.id, gate.pending.id]);
          return { approvalPending: gate.pending, wastage: t };
        }
      }
      const dayId = await openDay(c, req.auth.branchId);
      const entries = [];
      entries.push(await writeOffFine(c, req.auth, dayId, j, allowedPart, price24, "5350", `هدر الورشة المسموح — ${j.ref}`));
      if (decision === "writeoff") entries.push(await writeOffFine(c, req.auth, dayId, j, excess, price24, "5360", `هدر الورشة الزائد المعتمد — ${j.ref}`));
      entries.push(await accrueFees(c, req.auth, dayId, j, t));
      // الزائد بلا شطب مطالبةٌ مفتوحة: يبقى ذهبًا لدى الورشة (1250) حتى يُسوّى
      const claim = excess > 0 && decision === "claim";
      const settlement = claim ? { kind: "claim", fine: excess, openedAt: new Date().toISOString(), price24 } : null;
      const { rows } = await c.query(
        `update workshop_jobs set status = 'closed', worked_weight = $2, returned_weight = $3, wastage_fine = $4, allowed_fine = $5, excess_fine = $6,
                price24 = $7, fees = $8, settlement = $9, closed_at = now(), closed_by = $10 where id = $1 returning *`,
        [j.id, roundWeight(t.pieces + t.filings), t.returned, t.wastage, t.allowed, excess, price24 || null,
         JSON.stringify({ base: t.fees, vat: t.vat, total: roundMoney(t.fees + t.vat) }), settlement ? JSON.stringify(settlement) : null, req.auth.userId]);
      return { job: shape(rows[0]), wastage: t, journalEntryIds: entries.filter(Boolean) };
    });
    reply(res, out);
  } catch (err) { next(err); }
});

// تسوية مطالبة الهدر الزائد: خصمٌ نقدي (من أجورها أوّلًا) أو ذهبٌ مردود، أو شطبٌ/إبقاءٌ باعتماد
router.post("/workshop/jobs/:id/settle", async (req, res, next) => {
  const b = req.body || {};
  const kind = ["cash", "return", "writeoff", "keep"].includes(b.kind) ? b.kind : null;
  const price24 = Number(b.price24) || 0;
  if (!kind) return res.status(400).json({ error: "invalid_kind" });
  if (kind === "return") { const e = evidenceError(b.evidence, "returned"); if (e) return res.status(400).json({ error: e }); }
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const j = await loadJob(c, req.auth, req.params.id);
      if (!j) return { error: "job_not_found" };
      const s = j.settlement;
      if (j.status !== "closed" || !s || s.kind !== "claim" || s.settledAt) return { error: "no_open_claim" };
      const fine = Number(s.fine);
      if ((kind === "cash" || kind === "writeoff") && !(price24 > 0)) return { error: "price_required" };
      if (kind === "writeoff" || kind === "keep") {
        const gate = await approvalGate(c, req.auth, {
          kind: "workshop_wastage", amount: roundMoney(fine * (price24 || Number(s.price24) || 0)), approvalId: b.approvalId || null,
          note: `${kind === "writeoff" ? "شطب" : "إبقاء"} مطالبة الورشة ${j.workshop_name} (${j.ref}) بـ${fine} جم صافٍ`,
          payload: { jobId: j.id, action: "settle", kind, price24 },
        });
        if (gate.error) return gate;
        if (gate.pending) return { approvalPending: gate.pending };
      }
      const dayId = await openDay(c, req.auth.branchId);
      let journalEntryId = null, detail = {};
      if (kind === "cash") {
        const value = roundMoney(fine * price24);
        const owed = j.workshop_id ? await feesOwed(c, req.auth.branchId, j.workshop_id) : 0;
        const fromFees = roundMoney(Math.min(value, Math.max(0, owed)));
        await ledger(c, req.auth, dayId, { op: "workshop_claim_settle", karat: j.karat, weight: fine / purityOf(j.karat), fine, from: "1250", to: null, refId: j.id, note: `تسوية مطالبة ${j.ref} نقدًا` });
        journalEntryId = await postJournalEntry(c, {
          branchId: req.auth.branchId, businessDayId: dayId, opType: "workshop_claim_settle", refTable: "workshop_jobs", refId: j.id,
          description: `تسوية مطالبة الورشة ${j.workshop_name} — ${j.ref}`, createdBy: req.auth.userId,
          lines: [
            { account: "2120", side: "debit", amount: fromFees },
            { account: "1320", side: "debit", amount: roundMoney(value - fromFees) },
            { account: "1220", side: "credit", amount: value },
          ],
        });
        if (fromFees > 0) await c.query(
          `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, fees_amount, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'decrease',$4,'workshop_jobs',$5,$6,$7)`,
          [req.auth.branchId, j.workshop_id, dayId, fromFees, j.id, `خصم مطالبة ${j.ref} من الأجور`, req.auth.userId]);
        detail = { value, fromFees, receivable: roundMoney(value - fromFees) };
      } else if (kind === "return") {
        const weight = roundWeight(fine / purityOf(j.karat));
        await safeTx(c, req.auth, dayId, { direction: "in", karat: j.karat, weight, note: `ذهب مردود عن مطالبة ${j.ref}`, refId: j.id });
        await ledger(c, req.auth, dayId, { op: "workshop_receive", karat: j.karat, weight, fine, from: "1250", to: "1220", refId: j.id, note: `ذهب مردود عن مطالبة ${j.ref}` });
        detail = { weight, evidence: cleanEv(b.evidence) };
      } else if (kind === "writeoff") {
        journalEntryId = await writeOffFine(c, req.auth, dayId, j, fine, price24, "5360", `شطب مطالبة الورشة المعتمد — ${j.ref}`);
      }
      const settlement = { ...s, settledAt: new Date().toISOString(), settledBy: req.auth.userId, settledKind: kind, price24: price24 || s.price24, journalEntryId, ...detail };
      const { rows } = await c.query("update workshop_jobs set settlement = $2 where id = $1 returning *", [j.id, JSON.stringify(settlement)]);
      return { job: shape(rows[0]), journalEntryId };
    });
    reply(res, out);
  } catch (err) { next(err); }
});

// سداد أجور الورشة من الخزنة: مدين 2120 دائن 1110/1120، ودفتر الورشة ينقص
router.post("/workshop/pay-fees", async (req, res, next) => {
  const b = req.body || {};
  const amount = roundMoney(Number(b.amount) || 0);
  const method = b.method === "network" ? "network" : "cash";
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
  if (!isManager(req.auth)) return res.status(403).json({ error: "manager_only" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: sp } = await c.query("select * from suppliers where id = $1 and branch_id = $2 for update", [b.workshopId, req.auth.branchId]);
      const s = sp[0];
      if (!s) return { error: "workshop_not_found" };
      const owed = await feesOwed(c, req.auth.branchId, s.id);
      if (amount > owed + 0.005) return { error: "amount_exceeds_owed", owed };
      const bal = await poolBalance(c, req.auth.branchId, "safe", method);
      if (amount > bal + 0.005) return { error: "insufficient_safe_cash", available: bal };
      const dayId = await openDay(c, req.auth.branchId);
      const note = `سداد أجور الورشة ${s.name}`;
      const { rows: tx } = await c.query(
        `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,'safe',$3,'out',$4,'supplier_payment','suppliers',$5,$6,$7) returning id`,
        [req.auth.branchId, dayId, method, amount, s.id, note, req.auth.userId]);
      const journalEntryId = await postJournalEntry(c, {
        branchId: req.auth.branchId, businessDayId: dayId, opType: "workshop_fees_paid", refTable: "cash_tx", refId: tx[0].id,
        description: note, createdBy: req.auth.userId,
        lines: [{ account: "2120", side: "debit", amount }, { account: method === "network" ? "1120" : "1110", side: "credit", amount }],
      });
      await c.query(
        `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, fees_amount, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,'decrease',$4,'cash_tx',$5,$6,$7)`,
        [req.auth.branchId, s.id, dayId, amount, tx[0].id, note, req.auth.userId]);
      return { ok: true, journalEntryId, owed: roundMoney(owed - amount) };
    });
    reply(res, out);
  } catch (err) { next(err); }
});

// «كم ضاع في التصنيع؟» (المرجع wastageReportOf): الأوامر المقفلة في الفترة بنسبة هدرها ومسموحها وزائدها ومصيره،
// وكم من أوزانها كُتب باليد، وما يزال قيد الاستلام، والمطالبات المفتوحة بعمرها — ومجاميع لكل ورشة ولكل عيار.
async function wastageReport(c, branchId, { from = null, to = null, claimDays = 30 } = {}) {
  const { rows } = await c.query(
    `select * from workshop_jobs where branch_id = $1 order by created_at`, [branchId]);
  // تاريخ الإقفال بيوم الرياض لا بـUTC — كي لا يقع إقفال منتصف الليل في يومٍ آخر
  const dayOf = (d) => new Date(new Date(d).getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const inRange = (d) => (!from || dayOf(d) >= from) && (!to || dayOf(d) <= to);
  const manualOf = (j) => {
    const evs = [...(j.issues || []).map((x) => x.evidence), ...liveReceipts(j).map((r) => r.evidence), j.evidence?.worked, j.evidence?.returned].filter(Boolean);
    return { weighed: evs.length, manual: evs.filter((e) => e.source === "manual").length };
  };
  const closed = rows.filter((j) => j.status === "closed" && j.closed_at && inRange(j.closed_at));
  const out = closed.map((j) => {
    const t = calcOf(j);
    const legacy = !(j.issues || []).length || !(j.receipts || []).length;
    const issued = legacy ? fineWeight(Number(j.issued_weight), j.karat) : t.issuedFine;
    const back = legacy ? fineWeight(Number(j.returned_weight) || 0, j.karat) : t.returnedFine;
    const made = legacy ? fineWeight(Number(j.worked_weight) || 0, j.karat) : t.outFine;
    const loss = Number(j.wastage_fine) || 0, allowed = Number(j.allowed_fine) || 0, over = Number(j.excess_fine) || 0;
    const m = manualOf(j);
    return {
      id: j.id, ref: j.ref, workshop: j.workshop_name, workshopId: j.workshop_id, karat: j.karat,
      issued: roundWeight(issued), out: roundWeight(made), returned: roundWeight(back), loss: roundWeight(loss),
      lossPct: issued > 0 ? Math.round(loss / issued * 10000) / 100 : 0, allowPct: Number(j.allowed_pct), allowed: roundWeight(allowed),
      over: roundWeight(over), overValue: roundMoney(over * (Number(j.price24) || 0)),
      fate: over > 0.0005 ? (j.settlement?.kind === "claim" ? "claim" : "writeoff") : null, closedAt: j.closed_at, ...m,
    };
  });
  const sum = (arr, k) => arr.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const agg = (arr) => {
    const issued = sum(arr, "issued"), loss = sum(arr, "loss");
    return { jobs: arr.length, issued: roundWeight(issued), loss: roundWeight(loss), lossPct: issued > 0 ? Math.round(loss / issued * 10000) / 100 : 0,
      allowed: roundWeight(sum(arr, "allowed")), over: roundWeight(sum(arr, "over")), overValue: roundMoney(sum(arr, "overValue")),
      weighed: sum(arr, "weighed"), manual: sum(arr, "manual") };
  };
  const total = agg(out);
  total.manualPct = total.weighed ? Math.round(total.manual / total.weighed * 100) : 0;
  const group = (keyOf, labelOf) => [...new Set(out.map(keyOf))].map((k) => ({ key: k, label: labelOf(k), ...agg(out.filter((x) => keyOf(x) === k)) }))
    .sort((a, b) => b.lossPct - a.lossPct);
  const receiving = rows.filter((j) => j.status === "open" || j.status === "received" || j.status === "pending").map((j) => {
    const t = calcOf(j);
    return { id: j.id, ref: j.ref, workshop: j.workshop_name, issued: t.issuedFine, received: roundWeight(t.outFine + t.returnedFine),
      left: roundWeight(t.issuedFine - t.outFine - t.returnedFine), manual: manualOf(j).manual };
  });
  const now = Date.now();
  const claimRows = rows.filter((j) => j.settlement?.kind === "claim" && !j.settlement.settledAt).map((j) => {
    const age = Math.floor((now - new Date(j.settlement.openedAt).getTime()) / 86400000);
    return { id: j.id, ref: j.ref, workshop: j.workshop_name, grams: Number(j.settlement.fine), age, overdue: age > claimDays,
      value: roundMoney(Number(j.settlement.fine) * (Number(j.settlement.price24) || 0)) };
  });
  return {
    from, to, rows: out, total, receiving,
    byWorkshop: group((x) => x.workshop, (k) => k), byKarat: group((x) => x.karat, (k) => `عيار ${k}`),
    claims: { rows: claimRows, fine: roundWeight(sum(claimRows, "grams")), value: roundMoney(sum(claimRows, "value")), overdue: claimRows.filter((x) => x.overdue).length },
  };
}

router.get("/workshop/report", async (req, res, next) => {
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query("select sale_prefs from branch_settings where branch_id = $1", [req.auth.branchId]);
      const claimDays = Number(rows[0]?.sale_prefs?.wastage?.claimDays) || 30;
      return wastageReport(c, req.auth.branchId, { from: day(req.query.from), to: day(req.query.to), claimDays });
    });
    res.json(out);
  } catch (err) { next(err); }
});

export default router;
export { wastageOf, totalsOf, wastageReport };
