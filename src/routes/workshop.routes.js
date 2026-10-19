import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { approvalGate } from "../domain/approvals.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";

/**
 * الورشة ونسبة الهدر من الميزان (migration 084).
 *   GET  /workshop/jobs
 *   POST /workshop/jobs                 { workshopName, karat, weight, allowedPct, basis: in|out, evidence }
 *   POST /workshop/jobs/:id/receive     { workedWeight, returnedWeight, price24, evidence, approvalId? }
 * الصرف: ذهبٌ خام من الخزنة إلى الورشة (1220 ← 1250) بوزنه. الاستلام: المشغول والمردود إلى الخزنة (1250 ← 1220)،
 * والهدر = الصافي المصروف − الصافي المستلم. المسموح = النسبة × الأساس (المصروف «in» أو المشغول «out»).
 * داخل ضجيج الميزان (0.01 جم × عدد الوزنات) «مطابق». الزائد فوق المسموح يُعتمد (workshop_wastage) ولا يُقفل قبل اعتماده.
 * الدليل لكل وزنة: { source: "scale", raw } أو { source: "manual", reason } — والمكتوب بلا سببٍ مرفوض.
 */
const router = Router();
router.use("/workshop", authenticate, requireAnyPage("scrapCustody", "inventory"));
const KARATS = [24, 22, 21, 18, 14];
const SCALE_STEP = 0.01;

function evidenceError(ev, field) {
  const e = ev?.[field];
  if (!e || (e.source !== "scale" && e.source !== "manual")) return `${field}_evidence_required`;
  if (e.source === "manual" && String(e.reason || "").trim().length < 3) return `${field}_manual_reason_required`;
  return null;
}
const cleanEv = (e) => (e ? { source: e.source, raw: e.raw != null ? String(e.raw).slice(0, 60) : null, reason: e.reason ? String(e.reason).slice(0, 120) : null, at: new Date().toISOString() } : null);

const shape = (j) => ({
  id: j.id, ref: j.ref, workshopName: j.workshop_name, karat: j.karat, issuedWeight: Number(j.issued_weight), allowedPct: Number(j.allowed_pct),
  basis: j.basis, status: j.status, workedWeight: j.worked_weight == null ? null : Number(j.worked_weight),
  returnedWeight: j.returned_weight == null ? null : Number(j.returned_weight), wastageFine: j.wastage_fine == null ? null : Number(j.wastage_fine),
  allowedFine: j.allowed_fine == null ? null : Number(j.allowed_fine), excessFine: j.excess_fine == null ? null : Number(j.excess_fine),
  evidence: j.evidence || {}, note: j.note || "", createdAt: j.created_at, closedAt: j.closed_at, approvalId: j.approval_id,
});

// حسبة الهدر بالصافي — نقيّة
function wastageOf({ karat, issued, worked, returned, pct, basis, weighings = 3 }) {
  const issuedFine = fineWeight(issued, karat), workedFine = fineWeight(worked, karat), returnedFine = fineWeight(returned, karat);
  const wastage = roundWeight(issuedFine - workedFine - returnedFine);
  const base = basis === "out" ? workedFine : issuedFine;
  const allowed = roundWeight(base * (Number(pct) || 0) / 100);
  const noise = roundWeight(fineWeight(SCALE_STEP * weighings, karat));
  return { wastage, allowed, noise, excess: roundWeight(Math.max(0, wastage - allowed - noise)), overReturn: wastage < -noise };
}

router.get("/workshop/jobs", async (req, res, next) => {
  try {
    const { rows } = await withBranch(req.auth.branchId, (c) => c.query(
      "select * from workshop_jobs where branch_id = $1 order by (status = 'closed'), created_at desc limit 200", [req.auth.branchId]));
    res.json({ jobs: rows.map(shape) });
  } catch (err) { next(err); }
});

router.post("/workshop/jobs", async (req, res, next) => {
  const b = req.body || {};
  const karat = Number(b.karat), weight = roundWeight(Number(b.weight)), pct = Math.max(0, Math.min(20, Number(b.allowedPct) || 0));
  const name = String(b.workshopName || "").trim().slice(0, 80);
  const basis = b.basis === "out" ? "out" : "in";
  if (!name) return res.status(400).json({ error: "workshop_required" });
  if (!KARATS.includes(karat) || !(weight > 0)) return res.status(400).json({ error: "invalid_karat_or_weight" });
  const evErr = evidenceError(b.evidence, "issued");
  if (evErr) return res.status(400).json({ error: evErr });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: bal } = await c.query(
        `select coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as w from safe_gold_tx
          where branch_id = $1 and karat = $2 and kind = 'raw'`, [req.auth.branchId, karat]);
      const available = Number(bal[0].w) || 0;
      if (weight > available + 0.0005) return { error: "insufficient_safe_gold", available, requested: weight };
      const { rows: day } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      const { rows: n } = await c.query("select count(*)::int + 1 as n from workshop_jobs where branch_id = $1", [req.auth.branchId]);
      const ref = `WSH-${String(n[0].n).padStart(5, "0")}`;
      const label = `صرف للورشة ${name} — ${ref}`;
      const { rows } = await c.query(
        `insert into workshop_jobs (branch_id, ref, workshop_name, karat, issued_weight, allowed_pct, basis, evidence, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [req.auth.branchId, ref, name, karat, weight, pct, basis, JSON.stringify({ issued: cleanEv(b.evidence.issued) }), String(b.note || "").slice(0, 200) || null, req.auth.userId]);
      await c.query(
        `insert into safe_gold_tx (branch_id, business_day_id, direction, karat, weight, kind, destination, note, created_by, ref_table, ref_id)
         values ($1,$2,'out',$3,$4,'raw','workshop',$5,$6,'workshop_jobs',$7)`,
        [req.auth.branchId, day[0]?.id || null, karat, weight, label, req.auth.userId, rows[0].id]);
      await c.query(
        `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'workshop_issue',$3,$4,$5,'1220','1250','workshop_jobs',$6,$7,$8)`,
        [req.auth.branchId, day[0]?.id || null, karat, weight, fineWeight(weight, karat), rows[0].id, label, req.auth.userId]);
      return { job: shape(rows[0]) };
    });
    if (out.error) return res.status(409).json(out);
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.post("/workshop/jobs/:id/receive", async (req, res, next) => {
  const b = req.body || {};
  const worked = roundWeight(Number(b.workedWeight) || 0), returned = roundWeight(Number(b.returnedWeight) || 0);
  const price24 = Number(b.price24) || 0;
  if (!(worked >= 0) || !(returned >= 0) || worked + returned <= 0) return res.status(400).json({ error: "invalid_weights" });
  for (const f of ["worked", "returned"].filter((f) => (f === "worked" ? worked : returned) > 0)) {
    const e = evidenceError(b.evidence, f);
    if (e) return res.status(400).json({ error: e });
  }
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query("select * from workshop_jobs where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const j = rows[0];
      if (!j) return { error: "job_not_found" };
      if (j.status === "closed") return { error: "job_closed" };
      const w = wastageOf({ karat: j.karat, issued: Number(j.issued_weight), worked, returned, pct: Number(j.allowed_pct), basis: j.basis });
      // الزيادة فوق ضجيج الميزان باطلة: المستلم أكثر من المصروف خطأُ وزنٍ لا هدرٌ سالب
      if (w.overReturn) return { error: "returned_more_than_issued", wastage: w.wastage };
      if (w.wastage > w.noise && !(price24 > 0)) return { error: "price_required" };
      const value = (fine) => roundMoney(Math.max(0, fine) * price24);
      const allowedPart = Math.max(0, Math.min(w.wastage, w.allowed + w.noise));
      if (w.excess > 0) {
        const gate = await approvalGate(c, req.auth, {
          kind: "workshop_wastage", amount: value(w.excess), approvalId: b.approvalId || null,
          note: `هدر الورشة ${j.workshop_name} (${j.ref}) فوق المسموح بـ${w.excess} جم صافٍ — المسموح ${w.allowed} جم`,
          payload: { jobId: j.id, workedWeight: worked, returnedWeight: returned, price24, evidence: b.evidence || {} },
        });
        if (gate.error) return gate;
        if (gate.pending) {
          await c.query("update workshop_jobs set status = 'pending', approval_id = $2 where id = $1", [j.id, gate.pending.id]);
          return { approvalPending: gate.pending, wastage: w };
        }
      }
      const { rows: day } = await c.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      const dayId = day[0]?.id || null;
      const label = `استلام من الورشة ${j.workshop_name} — ${j.ref}`;
      for (const [weight, kind] of [[worked, "crafted"], [returned, "raw"]]) {
        if (!(weight > 0)) continue;
        await c.query(
          `insert into safe_gold_tx (branch_id, business_day_id, direction, karat, weight, kind, note, created_by, ref_table, ref_id)
           values ($1,$2,'in',$3,$4,$5,$6,$7,'workshop_jobs',$8)`,
          [req.auth.branchId, dayId, j.karat, weight, kind, `${label} — ${kind === "crafted" ? "مشغول" : "مردود"}`, req.auth.userId, j.id]);
        await c.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'workshop_receive',$3,$4,$5,'1250','1220','workshop_jobs',$6,$7,$8)`,
          [req.auth.branchId, dayId, j.karat, weight, fineWeight(weight, j.karat), j.id, label, req.auth.userId]);
      }
      // الهدر يخرج من 1250 بوزنه، وقيمته بسعر اليوم: المسموح 5350 والزائد المعتمد 5360
      let journalEntryId = null;
      if (w.wastage > 0.0005) {
        const purity = fineWeight(1, j.karat) || 1;
        await c.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'workshop_wastage',$3,$4,$5,'1250',null,'workshop_jobs',$6,$7,$8)`,
          [req.auth.branchId, dayId, j.karat, roundWeight(w.wastage / purity), w.wastage, j.id, `هدر ${j.ref}`, req.auth.userId]);
        const a = value(allowedPart), x = value(w.wastage - allowedPart);
        if (a + x > 0) journalEntryId = await postJournalEntry(c, {
          branchId: req.auth.branchId, businessDayId: dayId, opType: "workshop_wastage", refTable: "workshop_jobs", refId: j.id,
          description: `هدر الورشة ${j.workshop_name} — ${j.ref}`, createdBy: req.auth.userId,
          lines: [
            ...(a > 0 ? [{ account: "5350", side: "debit", amount: a }] : []),
            ...(x > 0 ? [{ account: "5360", side: "debit", amount: x }] : []),
            { account: "1220", side: "credit", amount: roundMoney(a + x) },
          ],
        });
      }
      const ev = { ...(j.evidence || {}), ...(worked > 0 ? { worked: cleanEv(b.evidence?.worked) } : {}), ...(returned > 0 ? { returned: cleanEv(b.evidence?.returned) } : {}) };
      const { rows: up } = await c.query(
        `update workshop_jobs set status = 'closed', worked_weight = $2, returned_weight = $3, wastage_fine = $4, allowed_fine = $5, excess_fine = $6,
                price24 = $7, evidence = $8, closed_at = now(), closed_by = $9 where id = $1 returning *`,
        [j.id, worked, returned, w.wastage, w.allowed, w.excess, price24 || null, JSON.stringify(ev), req.auth.userId]);
      return { job: shape(up[0]), wastage: w, journalEntryId };
    });
    if (out.approvalPending) return res.status(202).json(out);
    if (out.error) return res.status(out.error === "job_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

export default router;
export { wastageOf };
