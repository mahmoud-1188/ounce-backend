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
      // الناقص يُعلَن قبل الرفع: الآيبان والهوية كلاهما يرفض البنكُ الملفَّ بغيابه (المرجع 5.2.0)
      const missing = rows.map((r) => {
        const why = [!(r.hr_profile?.nationalId || r.hr_profile?.iqamaNo) && "الهوية", !ibanOk(String(r.hr_profile?.iban || "")) && "الآيبان"].filter(Boolean);
        return why.length ? `${r.name} (${why.join(" و")})` : null;
      }).filter(Boolean);
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

/**
 * سلف الموظفين بالأقساط وتقييم الأداء (migration 060):
 *   GET  /hr/loans                      — السلف المفتوحة: المبلغ والمسدَّد والقسط والمتبقّي
 *   GET  /hr/evaluations?period=YYYY-MM
 *   POST /hr/evaluations { userId, period, score 1..5, criteria:{attendance, sales, conduct, skill}, note }
 */
router.get("/hr/loans", authenticate, requirePage("payroll"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select e.id, e.ref, e.amount, e.installments, e.repaid, e.created_at, e.settled, u.name as employee_name, e.employee_id
         from expenses e join users u on u.id = e.employee_id
        where e.branch_id = $1 and e.category = 'advance' and (e.settled = false or e.created_at > now() - interval '120 days')
        order by e.settled, e.created_at desc limit 300`, [req.auth.branchId])).rows);
    res.json({
      loans: rows.map((r) => {
        const amount = Number(r.amount), repaid = Number(r.repaid), n = Number(r.installments) || 1;
        const left = Math.round((amount - repaid) * 100) / 100;
        return {
          id: r.id, ref: r.ref, employeeId: r.employee_id, employeeName: r.employee_name, amount, repaid, installments: n,
          installment: n <= 1 ? left : Math.min(left, Math.round((amount / n) * 100) / 100), left, settled: r.settled, createdAt: r.created_at,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

const CRIT = ["attendance", "sales", "conduct", "skill"];
router.get("/hr/evaluations", authenticate, requirePage("payroll"), async (req, res, next) => {
  const period = /^\d{4}-\d{2}$/.test(String(req.query.period || "")) ? String(req.query.period) : null;
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select v.*, u.name as employee_name, b.name as by_name from hr_evaluations v join users u on u.id = v.user_id
         left join users b on b.id = v.created_by
        where v.branch_id = $1 and ($2::text is null or v.period = $2) order by v.period desc, u.name limit 500`,
      [req.auth.branchId, period])).rows);
    res.json({ evaluations: rows.map((v) => ({ id: v.id, userId: v.user_id, employeeName: v.employee_name, period: v.period, score: v.score, criteria: v.criteria || {}, note: v.note || "", by: v.by_name || "", createdAt: v.created_at })) });
  } catch (err) {
    next(err);
  }
});

router.post("/hr/evaluations", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  const b = req.body || {};
  const score = Math.round(Number(b.score));
  if (!b.userId) return res.status(400).json({ error: "employee_required" });
  if (!/^\d{4}-\d{2}$/.test(String(b.period || ""))) return res.status(400).json({ error: "invalid_period" });
  if (!(score >= 1 && score <= 5)) return res.status(400).json({ error: "invalid_score" });
  const criteria = {};
  for (const k of CRIT) { const v = Math.round(Number(b.criteria?.[k])); if (v >= 1 && v <= 5) criteria[k] = v; }
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: u } = await c.query("select id from users where id = $1 and branch_id = $2", [b.userId, req.auth.branchId]);
      if (!u[0]) return { error: "employee_not_found" };
      const { rows } = await c.query(
        `insert into hr_evaluations (branch_id, user_id, period, score, criteria, note, created_by) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (branch_id, user_id, period) do update set score = excluded.score, criteria = excluded.criteria, note = excluded.note, created_by = excluded.created_by, created_at = now()
         returning id`, [req.auth.branchId, b.userId, b.period, score, JSON.stringify(criteria), String(b.note || "").slice(0, 500) || null, req.auth.userId]);
      return { id: rows[0].id };
    });
    if (out.error) return res.status(400).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export { hrDocAlerts };
// ══ سياسة الموارد · الإضافي والمكافآت والجزاءات · الحضور بوقته (migration 099 — المرجع HrPage) ══════

const HR_DEFAULT_POLICY = { shiftStart: "09:00", shiftEnd: "21:00", graceMin: 15, weeklyOff: [5], docAlertDays: 30, maxLoanMultiple: 2, maxLoanMonths: 12 };
const hhmm = (v) => (/^\d{2}:\d{2}$/.test(String(v || "")) ? String(v) : null);
const minutesOf = (v) => { const m = /^(\d{2}):(\d{2})$/.exec(String(v || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

async function hrPolicyOf(c, branchId) {
  const { rows } = await c.query("select hr_policy from branch_settings where branch_id = $1", [branchId]);
  return { ...HR_DEFAULT_POLICY, ...(rows[0]?.hr_policy || {}) };
}

function cleanPolicy(b = {}) {
  const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  return {
    shiftStart: hhmm(b.shiftStart) || HR_DEFAULT_POLICY.shiftStart,
    shiftEnd: hhmm(b.shiftEnd) || HR_DEFAULT_POLICY.shiftEnd,
    graceMin: n(b.graceMin, 0, 180, HR_DEFAULT_POLICY.graceMin),
    weeklyOff: Array.isArray(b.weeklyOff) ? [...new Set(b.weeklyOff.map(Number).filter((d) => d >= 0 && d <= 6))] : HR_DEFAULT_POLICY.weeklyOff,
    docAlertDays: n(b.docAlertDays, 1, 365, HR_DEFAULT_POLICY.docAlertDays),
    maxLoanMultiple: n(b.maxLoanMultiple, 0, 12, HR_DEFAULT_POLICY.maxLoanMultiple),
    maxLoanMonths: n(b.maxLoanMonths, 1, 60, HR_DEFAULT_POLICY.maxLoanMonths),
  };
}

router.get("/hr/policy", authenticate, async (req, res, next) => {
  try { res.json({ policy: await withBranch(req.auth.branchId, (c) => hrPolicyOf(c, req.auth.branchId)) }); } catch (err) { next(err); }
});

router.put("/hr/policy", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  const policy = cleanPolicy(req.body || {});
  try {
    await withBranch(req.auth.branchId, (c) => c.query(
      `insert into branch_settings (branch_id, hr_policy) values ($1, $2::jsonb)
       on conflict (branch_id) do update set hr_policy = excluded.hr_policy`, [req.auth.branchId, JSON.stringify(policy)]));
    res.json({ policy });
  } catch (err) { next(err); }
});

const adjOf = (r) => ({ id: r.id, employeeId: r.user_id, name: r.name || null, period: r.period, kind: r.kind, hours: Number(r.hours) || 0,
  amount: Number(r.amount) || 0, reason: r.reason || "", by: r.by_name || "", at: r.created_at, cancelled: !!r.cancelled_at, inRun: !!r.in_run });

router.get("/hr/adjustments", authenticate, requirePage("payroll"), async (req, res, next) => {
  const period = /^\d{4}-\d{2}$/.test(String(req.query.period || "")) ? String(req.query.period) : null;
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select a.*, u.name, b.name as by_name,
              exists (select 1 from payroll_runs r where r.branch_id = a.branch_id and to_char(r.period, 'YYYY-MM') = a.period) as in_run
         from payroll_adjustments a join users u on u.id = a.user_id left join users b on b.id = a.created_by
        where a.branch_id = $1 and ($2::text is null or a.period = $2) order by a.created_at desc limit 200`,
      [req.auth.branchId, period])).rows);
    res.json({ adjustments: rows.map(adjOf) });
  } catch (err) { next(err); }
});

router.post("/hr/adjustments", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  const b = req.body || {};
  const kind = ["overtime", "bonus", "penalty"].includes(b.kind) ? b.kind : null;
  const period = /^\d{4}-\d{2}$/.test(String(b.period || "")) ? String(b.period) : null;
  const hours = Math.round((Number(b.hours) || 0) * 100) / 100;
  const reason = String(b.reason || "").trim().slice(0, 200);
  if (!kind || !period || !b.employeeId) return res.status(400).json({ error: "invalid_adjustment" });
  if (kind === "penalty" && !reason) return res.status(400).json({ error: "reason_required" });
  if (kind === "overtime" && !(hours > 0)) return res.status(400).json({ error: "hours_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: emp } = await c.query("select id, name, basic_salary, housing, transport, other_allowance from users where id = $1 and branch_id = $2", [b.employeeId, req.auth.branchId]);
      if (!emp[0]) return { error: "employee_not_found", status: 404 };
      const { rows: run } = await c.query("select 1 from payroll_runs where branch_id = $1 and to_char(period, 'YYYY-MM') = $2", [req.auth.branchId, period]);
      if (run[0]) return { error: "payroll_already_run", status: 409 };
      const e = emp[0];
      const basic = Number(e.basic_salary) || 0;
      const gross = basic + (Number(e.housing) || 0) + (Number(e.transport) || 0) + (Number(e.other_allowance) || 0);
      // الإضافي: أجر الساعة (الإجمالي ÷ 240) + 50٪ من أجر الساعة الأساسي — نظام العمل م107
      const amount = kind === "overtime" ? Math.round(((gross / 240) + 0.5 * (basic / 240)) * hours * 100) / 100 : Math.round((Number(b.amount) || 0) * 100) / 100;
      if (!(amount > 0)) return { error: "invalid_amount", status: 400 };
      const { rows } = await c.query(
        `insert into payroll_adjustments (branch_id, user_id, period, kind, hours, amount, reason, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.auth.branchId, e.id, period, kind, kind === "overtime" ? hours : 0, amount, reason || null, req.auth.userId]);
      return { adjustment: adjOf({ ...rows[0], name: e.name }) };
    });
    if (out.error) { const { status, ...body } = out; return res.status(status || 400).json(body); }
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.delete("/hr/adjustments/:id", authenticate, requirePage("payroll"), requireManager, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update payroll_adjustments a set cancelled_at = now()
          where a.id = $1 and a.branch_id = $2 and a.cancelled_at is null
            and not exists (select 1 from payroll_runs r where r.branch_id = a.branch_id and to_char(r.period, 'YYYY-MM') = a.period)
          returning a.*`, [req.params.id, req.auth.branchId]);
      return rows[0] ? { adjustment: adjOf(rows[0]) } : { error: "not_cancellable" };
    });
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

// الحضور والانصراف بوقته: الموظف لنفسه، والمدير ونائبه لأيّ موظف. التأخير والإضافي من الوردية وسماحها.
router.post("/hr-check", authenticate, async (req, res, next) => {
  const action = req.body?.action === "out" ? "out" : "in";
  const userId = req.body?.userId || req.auth.userId;
  if (!userId) return res.status(400).json({ error: "employee_required" });
  if (userId !== req.auth.userId && !["manager", "assistant"].includes(req.auth.role)) return res.status(403).json({ error: "manager_only" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: u } = await c.query("select id from users where id = $1 and branch_id = $2", [userId, req.auth.branchId]);
      if (!u[0]) return { error: "employee_not_found", status: 404 };
      const pol = await hrPolicyOf(c, req.auth.branchId);
      // اليوم والساعة بتوقيت الرياض
      const now = new Date(Date.now() + 3 * 3600 * 1000);
      const day = now.toISOString().slice(0, 10);
      const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
      if (action === "in") {
        const late = Math.max(0, mins - (minutesOf(pol.shiftStart) ?? 0) - (Number(pol.graceMin) || 0));
        const { rows } = await c.query(
          `insert into attendance (branch_id, user_id, date, status, check_in, late_min)
           values ($1,$2,$3,$4, now(), $5)
           on conflict (user_id, date) do update set check_in = coalesce(attendance.check_in, excluded.check_in),
             status = case when attendance.check_in is null then excluded.status else attendance.status end,
             late_min = case when attendance.check_in is null then excluded.late_min else attendance.late_min end
           returning *`, [req.auth.branchId, userId, day, late > 0 ? "late" : "present", late]);
        return { record: rows[0] };
      }
      const over = Math.max(0, mins - (minutesOf(pol.shiftEnd) ?? 24 * 60));
      const { rows } = await c.query(
        `update attendance set check_out = now(), overtime_min = $4
          where user_id = $1 and branch_id = $2 and date = $3 and check_in is not null and check_out is null returning *`,
        [userId, req.auth.branchId, day, over]);
      return rows[0] ? { record: rows[0] } : { error: "not_checked_in", status: 409 };
    });
    if (out.error) { const { status, ...body } = out; return res.status(status || 400).json(body); }
    res.json(out);
  } catch (err) { next(err); }
});

export { HR_DEFAULT_POLICY };
export default router;
