import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager, requirePage } from "../middleware/auth.js";

const router = Router();

/**
 * ملف الموظف (migration 058):
 *   PATCH /hr/staff/:id/profile { nationalId, iqamaNo, iqamaExpiry, passportNo, passportExpiry, phone, email, iban, bankName,
 *                                gosiNo, contractType, contractStart, contractEnd, probationEnd, department, jobTitle, emergencyContact }
 *   GET   /hr/alerts            — مستنداتٌ انتهت أو تنتهي خلال 60 يومًا
 *   GET   /payroll/runs/:runId/wps — ملف حماية الأجور (CSV) بالآيبان
 */
const TEXT = ["nationalId", "iqamaNo", "passportNo", "phone", "email", "iban", "bankName", "gosiNo", "contractType", "department", "jobTitle", "emergencyContact"];
const DATES = ["iqamaExpiry", "passportExpiry", "contractStart", "contractEnd", "probationEnd"];
const DOCS = [["iqamaExpiry", "الإقامة"], ["passportExpiry", "الجواز"], ["contractEnd", "العقد"], ["probationEnd", "فترة التجربة"]];
const ibanOk = (v) => /^SA\d{22}$/.test(v);

function cleanProfile(b = {}) {
  const out = {};
  for (const k of TEXT) if (b[k] != null) out[k] = String(b[k]).trim().slice(0, 80);
  for (const k of DATES) if (b[k] != null) out[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(b[k])) ? String(b[k]) : "";
  if (out.iban) out.iban = out.iban.replace(/\s+/g, "").toUpperCase();
  return out;
}

router.patch("/hr/staff/:id/profile", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  const p = cleanProfile(req.body || {});
  if (p.iban && !ibanOk(p.iban)) return res.status(400).json({ error: "invalid_iban" });
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => {
      const { rows: r } = await c.query("update users set hr_profile = hr_profile || $1::jsonb where id = $2 and branch_id = $3 returning id, name, hr_profile",
        [JSON.stringify(p), req.params.id, req.auth.branchId]);
      if (r[0]) await c.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'users',$3,$4)`,
        [req.auth.branchId, req.auth.userId, req.params.id, JSON.stringify({ action: "hr_profile", fields: Object.keys(p) })]);
      return r;
    });
    if (!rows[0]) return res.status(404).json({ error: "not_found" });
    res.json({ user: { id: rows[0].id, name: rows[0].name, profile: rows[0].hr_profile } });
  } catch (err) {
    next(err);
  }
});

async function hrDocAlerts(c, branchId, days = 60) {
  const { rows } = await c.query("select id, name, hr_profile from users where branch_id = $1 and active = true and role <> 'hidden'", [branchId]);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (const u of rows) for (const [k, label] of DOCS) {
    const d = u.hr_profile?.[k];
    if (!d) continue;
    const left = Math.round((new Date(d).getTime() - today.getTime()) / 86400000);
    if (left <= days) out.push({ userId: u.id, name: u.name, doc: label, date: d, daysLeft: left, level: left < 0 ? "block" : left <= 14 ? "warn" : "info" });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

router.get("/hr/alerts", authenticate, requirePage("payroll"), async (req, res, next) => {
  try {
    res.json({ alerts: await withBranch(req.auth.branchId, (c) => hrDocAlerts(c, req.auth.branchId)) });
  } catch (err) {
    next(err);
  }
});

router.get("/payroll/runs/:runId/wps", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: run } = await c.query("select * from payroll_runs where id = $1 and branch_id = $2", [req.params.runId, req.auth.branchId]);
      if (!run[0]) return { error: "not_found" };
      const { rows } = await c.query(
        `select l.*, u.name, u.ref, u.hr_profile from payroll_lines l join users u on u.id = l.user_id where l.payroll_run_id = $1 order by u.name`, [run[0].id]);
      const missing = rows.filter((r) => !ibanOk(String(r.hr_profile?.iban || ""))).map((r) => r.name);
      const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const n = (v) => (Number(v) || 0).toFixed(2);
      const head = ["Employee ID", "Employee Name", "National ID / Iqama", "IBAN", "Bank", "Basic Salary", "Housing", "Other Earnings", "Deductions", "Net Salary", "Period"];
      const period = String(run[0].period).slice(0, 7);
      const lines = rows.map((r) => [r.ref, r.name, r.hr_profile?.nationalId || r.hr_profile?.iqamaNo || "", r.hr_profile?.iban || "", r.hr_profile?.bankName || "",
        n(r.base_salary), n(r.housing), n(Number(r.transport) + Number(r.other_allowance) + Number(r.commission)),
        n(Number(r.gosi_employee) + Number(r.advances) + Number(r.absence_deduction)), n(r.net_pay), period].map(esc).join(","));
      return { csv: "﻿" + [head.join(","), ...lines].join("\r\n"), period, missing };
    });
    if (out.error) return res.status(404).json(out);
    if (req.query.format === "json") return res.json({ period: out.period, missing: out.missing, csv: out.csv });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="WPS-${out.period}.csv"`);
    res.send(out.csv);
  } catch (err) {
    next(err);
  }
});

export { hrDocAlerts };
export default router;
