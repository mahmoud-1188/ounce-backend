import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireManager, requireAnyPage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

/**
 * الرواتب والموارد البشرية بالكامل — migration 016.
 *
 * جداول gosi_rates/payroll_runs/payroll_lines/attendance/leave_requests/
 * commissions موجودة في schema.sql منذ البداية ومصروفة جزئيًا في
 * seed.sql (gosi_rates + posting_rules.payroll_run/payroll_pay/gosi_pay/
 * eos_pay) — لكن بلا endpoint واحد يلمسها، تمامًا كحال الأصول الثابتة
 * قبل migration 015.
 *
 * ⚠ فجوة حتى في المرجع نفسه: PayrollPage.js/computePayslip.js يقرآن
 * attendance/leaves كمصفوفتين محليتين، لكن لا شاشة واحدة في المرجع
 * تكتب فيهما فعليًا — absentDays/unpaidLeaveDays = صفر دائمًا عمليًا.
 * بما أن النطاق المطلوب هنا كامل، هذا الملف يبني endpoints حضور/إجازات
 * حقيقية فوق الجدولين الموجودين أصلًا، لا يترك نفس الفجوة الميتة.
 *
 * ⚠ حساب الحساب: GOSI_CEILING (45000) ثابتٌ يطابق GOSI_CEILING في
 * core/erp.js بالفرونت إند حرفيًا — لا عمود سقف في gosi_rates، فيبقى
 * ثابتًا مُكرَّرًا بقصد هنا تمامًا كأي ثابت آخر يُطابَق يدويًا بين
 * الطرفين في هذا المشروع (مثل CATEGORY_ACCOUNTS في expenses.routes.js).
 */
const GOSI_CEILING = 45000;

router.use("/hr", authenticate, requirePage("payroll"));
router.use("/commissions", authenticate, requirePage("payroll"));
router.use("/attendance", authenticate, requireAnyPage("attendanceHr", "payroll"));
router.use("/leave-requests", authenticate, requireAnyPage("attendanceHr", "payroll"));
router.use("/payroll", authenticate, requirePage("payroll"));

// ────────────────────────────────────────────────────────────────
//  بيانات HR للموظف (users.basic_salary/housing/transport/...)
// ────────────────────────────────────────────────────────────────

router.get("/hr/staff", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select u.id, u.name, u.ref, u.role, u.active, u.basic_salary, u.housing,
                u.transport, u.other_allowance, u.nationality, u.hire_date,
                u.left_at, u.leave_reason, u.eos_paid,
                c.basis as commission_basis, c.rate as commission_rate,
                c.target as commission_target, c.per_invoice as commission_per_invoice
           from users u
           left join commissions c on c.user_id = u.id
          where u.branch_id = $1
          order by u.name`,
        [req.auth.branchId]
      );
      return { staff: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/hr/staff/:id", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const basicSalary = body.basicSalary === "" || body.basicSalary == null ? null : roundMoney(body.basicSalary);
  // ⚠ null صريح = "اتّبع الافتراضي" (25٪ من الأساسي) — يطابق placeholder
  // "بدل سكن (فارغ = 25٪)" في HrFieldsForm الأصلي حرفيًا.
  const housing = body.housing === "" || body.housing == null ? null : roundMoney(body.housing);
  const transport = roundMoney(body.transport || 0);
  const otherAllowance = roundMoney(body.otherAllowance || 0);
  const nationality = body.nationality === "expat" ? "expat" : "saudi";
  const hireDate = body.hireDate || null;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `update users
            set basic_salary = $1, housing = $2, transport = $3, other_allowance = $4,
                nationality = $5, hire_date = $6
          where id = $7 and branch_id = $8
          returning id, name, ref, basic_salary, housing, transport, other_allowance, nationality, hire_date`,
        [basicSalary, housing, transport, otherAllowance, nationality, hireDate, req.params.id, req.auth.branchId]
      );
      if (!rows[0]) return { error: "not_found" };

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'users',$3,$4)`,
        [req.auth.branchId, req.auth.userId, req.params.id, JSON.stringify({ action: "hr_fields", basicSalary, nationality, hireDate })]
      );
      return { user: rows[0] };
    });
    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
//  عمولات البائعين — upsert صف واحد لكل مستخدم (commissions.user_id
//  فريد الآن — migration 016)
// ────────────────────────────────────────────────────────────────

router.put("/commissions/:userId", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const basis = body.basis === "sales" ? "sales" : "profit";
  const rate = Math.max(0, Number(body.rate) || 0);
  const target = Math.max(0, roundMoney(body.target || 0));
  const perInvoice = Math.max(0, roundMoney(body.perInvoice || 0));

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: userRows } = await client.query(
        `select id from users where id = $1 and branch_id = $2`,
        [req.params.userId, req.auth.branchId]
      );
      if (!userRows[0]) return { error: "not_found" };

      const { rows } = await client.query(
        `insert into commissions (branch_id, user_id, basis, rate, target, per_invoice)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id) do update
           set basis = excluded.basis, rate = excluded.rate,
               target = excluded.target, per_invoice = excluded.per_invoice
         returning *`,
        [req.auth.branchId, req.params.userId, basis, rate, target, perInvoice]
      );
      return { rule: rows[0] };
    });
    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/commissions/:userId", requireManager, async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rowCount } = await client.query(
        `delete from commissions where user_id = $1 and branch_id = $2`,
        [req.params.userId, req.auth.branchId]
      );
      return { deleted: rowCount > 0 };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
//  الحضور — تسجيل يوم لموظف (حاضر/غائب/متأخر)، فريد لكل (موظف، يوم)
// ────────────────────────────────────────────────────────────────

router.get("/attendance", async (req, res, next) => {
  const month = typeof req.query.month === "string" ? req.query.month : null; // 'YYYY-MM'
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        month
          ? `select * from attendance where branch_id = $1 and to_char(date, 'YYYY-MM') = $2 order by date desc`
          : `select * from attendance where branch_id = $1 order by date desc limit 500`,
        month ? [req.auth.branchId, month] : [req.auth.branchId]
      );
      return { attendance: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/attendance", async (req, res, next) => {
  const body = req.body || {};
  const userId = body.userId;
  const date = body.date;
  const status = ["present", "absent", "late"].includes(body.status) ? body.status : "present";
  const excused = !!body.excused;
  if (!userId) return res.status(400).json({ error: "employee_required" });
  if (!date) return res.status(400).json({ error: "date_required" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: userRows } = await client.query(
        `select id from users where id = $1 and branch_id = $2`,
        [userId, req.auth.branchId]
      );
      if (!userRows[0]) return { error: "employee_not_found" };

      // ⚠ upsert لا insert فقط: تصحيح تسجيل يوم سابق (حاضر ↔ غائب) أشيع
      // من افتراض عدم وجود خطأ إدخال — index فريد (user_id, date) من
      // migration 016 يجعل on conflict ممكنًا.
      const { rows } = await client.query(
        `insert into attendance (branch_id, user_id, date, status, excused, note)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (user_id, date) do update
           set status = excluded.status, excused = excluded.excused, note = excluded.note
         returning *`,
        [req.auth.branchId, userId, date, status, excused, body.note || null]
      );
      return { record: rows[0] };
    });
    if (result.error === "employee_not_found") return res.status(404).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
//  طلبات الإجازة — تقديم + قرار (اعتماد/رفض)
// ────────────────────────────────────────────────────────────────

router.get("/leave-requests", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select * from leave_requests where branch_id = $1 order by created_at desc limit 300`,
        [req.auth.branchId]
      );
      return { leaveRequests: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/leave-requests", async (req, res, next) => {
  const body = req.body || {};
  const userId = body.userId;
  const type = ["annual", "sick", "unpaid", "emergency"].includes(body.type) ? body.type : null;
  const startDate = body.startDate;
  const endDate = body.endDate;
  if (!userId) return res.status(400).json({ error: "employee_required" });
  if (!type) return res.status(400).json({ error: "invalid_leave_type" });
  if (!startDate || !endDate) return res.status(400).json({ error: "dates_required" });
  if (new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: "invalid_date_range" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: userRows } = await client.query(
        `select id from users where id = $1 and branch_id = $2`,
        [userId, req.auth.branchId]
      );
      if (!userRows[0]) return { error: "employee_not_found" };

      const { rows } = await client.query(
        `insert into leave_requests (branch_id, user_id, type, start_date, end_date)
         values ($1,$2,$3,$4,$5)
         returning *`,
        [req.auth.branchId, userId, type, startDate, endDate]
      );
      return { leaveRequest: rows[0] };
    });
    if (result.error === "employee_not_found") return res.status(404).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/leave-requests/:id/decide", requireManager, async (req, res, next) => {
  const decision = req.body?.decision === "approved" ? "approved" : req.body?.decision === "rejected" ? "rejected" : null;
  if (!decision) return res.status(400).json({ error: "invalid_decision" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `update leave_requests set status = $1
          where id = $2 and branch_id = $3 and status = 'pending'
          returning *`,
        [decision, req.params.id, req.auth.branchId]
      );
      if (!rows[0]) return { error: "not_found_or_decided" };
      return { leaveRequest: rows[0] };
    });
    if (result.error === "not_found_or_decided") return res.status(409).json({ error: "not_found_or_decided" });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ────────────────────────────────────────────────────────────────
//  مسيّر الرواتب
// ────────────────────────────────────────────────────────────────

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

const CASH_ACCOUNTS = {
  safe_cash: { pool: "safe", method: "cash", account: "1110" },
  safe_network: { pool: "safe", method: "network", account: "1120" },
};

/**
 * saleProfitOf منقولة حرفيًا من domain/helpers.js الفرونت إندي (نفس
 * الصيغة بالضبط) — لازمة هنا لأن العمولة بأساس "الربح" تحتاج ربح كل
 * سطر بيع، وربح البيع غير مخزَّن كعمود جاهز في sales/sale_lines.
 */
function saleLineProfit(line) {
  const basis = (Number(line.cost_per_gram_snapshot) || 0) * (Number(line.weight_snapshot) || 0) +
    (Number(line.workmanship_snapshot) || 0);
  return Number(line.unit_price) * Number(line.quantity) - basis * Number(line.quantity);
}

/**
 * يبني معاينة/كشف رواتب شهر واحد — منقول منطقيًا عن computePayslip.js +
 * buildPayrollRun (GoldInventoryApp.js المرجعي) معًا، بقراءة فعلية من
 * القاعدة بدل حالة محلية.
 */
async function buildPayrollSlips(client, branchId, period) {
  const { rows: staff } = await client.query(
    `select id, name, basic_salary, housing, transport, other_allowance, nationality
       from users where branch_id = $1 and active = true and basic_salary > 0`,
    [branchId]
  );
  if (!staff.length) return [];

  const { rows: gosiRates } = await client.query(`select * from gosi_rates`);
  const gosiByNationality = Object.fromEntries(gosiRates.map((r) => [r.nationality, r]));

  const { rows: openAdvances } = await client.query(
    `select id, employee_id, amount from expenses
      where branch_id = $1 and category = 'advance' and settled = false`,
    [branchId]
  );

  const { rows: attendanceRows } = await client.query(
    `select user_id, count(*)::int as absent_days from attendance
      where branch_id = $1 and to_char(date, 'YYYY-MM') = $2 and status = 'absent' and excused = false
      group by user_id`,
    [branchId, period]
  );
  const absentByUser = Object.fromEntries(attendanceRows.map((r) => [r.user_id, r.absent_days]));

  const { rows: leaveRows } = await client.query(
    `select user_id, start_date, end_date from leave_requests
      where branch_id = $1 and type = 'unpaid' and status = 'approved'
        and to_char(start_date, 'YYYY-MM') = $2`,
    [branchId, period]
  );
  const unpaidLeaveByUser = {};
  for (const l of leaveRows) {
    const days = Math.round((new Date(l.end_date) - new Date(l.start_date)) / 86400000) + 1;
    unpaidLeaveByUser[l.user_id] = (unpaidLeaveByUser[l.user_id] || 0) + Math.max(1, days);
  }

  const { rows: commissionRules } = await client.query(
    `select * from commissions where branch_id = $1`,
    [branchId]
  );
  const commissionByUser = Object.fromEntries(commissionRules.map((r) => [r.user_id, r]));

  // ⚠ مرة واحدة لكل الفرع لا استعلام لكل موظف: أرخص، ونفس منطق باقي
  // هذا الباك إند (bootstrap.routes.js وغيره) في جلب دفعة ثم تصفية محليًا.
  const { rows: salesRows } = await client.query(
    `select s.id, s.seller_id, s.total, sl.quantity, sl.unit_price, sl.weight_snapshot,
            sl.cost_per_gram_snapshot, sl.workmanship_snapshot
       from sales s left join sale_lines sl on sl.sale_id = s.id
      where s.branch_id = $1 and to_char(s.date, 'YYYY-MM') = $2`,
    [branchId, period]
  );
  const salesBySeller = {};
  for (const r of salesRows) {
    if (!r.seller_id) continue;
    if (!salesBySeller[r.seller_id]) salesBySeller[r.seller_id] = { sales: new Map(), profit: 0, total: 0 };
    const bucket = salesBySeller[r.seller_id];
    if (!bucket.sales.has(r.id)) { bucket.sales.set(r.id, true); bucket.total += Number(r.total) || 0; }
    if (r.quantity != null) bucket.profit += saleLineProfit(r);
  }

  return staff.map((emp) => {
    const basic = roundMoney(emp.basic_salary);
    const housing = emp.housing != null ? roundMoney(emp.housing) : roundMoney(basic * 0.25);
    const transport = roundMoney(emp.transport || 0);
    const other = roundMoney(emp.other_allowance || 0);
    const gross = roundMoney(basic + housing + transport + other);
    const gosiSubject = Math.min(GOSI_CEILING, basic + housing);
    const rates = gosiByNationality[emp.nationality || "saudi"] || { employee_pct: 0, employer_pct: 0 };
    const gosiEmployee = roundMoney(gosiSubject * Number(rates.employee_pct));
    const gosiEmployer = roundMoney(gosiSubject * Number(rates.employer_pct));

    const advances = roundMoney(
      openAdvances.filter((a) => a.employee_id === emp.id).reduce((s, a) => s + Number(a.amount), 0)
    );
    const absentDays = absentByUser[emp.id] || 0;
    const unpaidLeaveDays = unpaidLeaveByUser[emp.id] || 0;
    const dayRate = roundMoney(gross / 30);
    const absenceDeduction = roundMoney(dayRate * (absentDays + unpaidLeaveDays));

    const rule = commissionByUser[emp.id];
    let commission = 0;
    if (rule) {
      const bucket = salesBySeller[emp.id] || { total: 0, profit: 0 };
      const base = rule.basis === "sales" ? bucket.total : bucket.profit;
      const metTarget = bucket.total >= (Number(rule.target) || 0);
      const pct = metTarget ? base * (Number(rule.rate) || 0) : 0;
      const flat = bucket.sales ? bucket.sales.size * (Number(rule.per_invoice) || 0) : 0;
      commission = roundMoney(Math.max(0, pct) + flat);
    }

    const deductions = roundMoney(gosiEmployee + advances + absenceDeduction);
    const net = roundMoney(gross + commission - deductions);

    const years = emp.hire_date ? (Date.now() - new Date(emp.hire_date).getTime()) / (365.25 * 86400000) : 0;
    const eosAccrual = roundMoney(years <= 5 ? gross / 24 : gross / 12);
    const employerCost = roundMoney(gross + commission + gosiEmployer + eosAccrual);

    return {
      employeeId: emp.id, employeeName: emp.name, nationality: emp.nationality || "saudi",
      basic, housing, transport, other, gross, commission,
      gosiEmployee, gosiEmployer, advances, absentDays, unpaidLeaveDays, absenceDeduction,
      deductions, net, eosAccrual, employerCost,
      advanceIds: openAdvances.filter((a) => a.employee_id === emp.id).map((a) => a.id),
    };
  });
}

router.get("/payroll/preview", async (req, res, next) => {
  const period = req.query.period;
  if (!/^\d{4}-\d{2}$/.test(period || "")) return res.status(400).json({ error: "invalid_period" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const slips = await buildPayrollSlips(client, req.auth.branchId, period);
      return { slips };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/payroll/runs", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: runs } = await client.query(
        `select * from payroll_runs where branch_id = $1 order by period desc`,
        [req.auth.branchId]
      );
      const { rows: lines } = await client.query(
        `select l.* from payroll_lines l
           join payroll_runs r on r.id = l.payroll_run_id
          where r.branch_id = $1`,
        [req.auth.branchId]
      );
      return { runs, lines };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/payroll/runs", requireManager, async (req, res, next) => {
  const period = req.body?.period;
  if (!/^\d{4}-\d{2}$/.test(period || "")) return res.status(400).json({ error: "invalid_period" });
  const periodDate = `${period}-01`;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: existing } = await client.query(
        `select id from payroll_runs where branch_id = $1 and period = $2`,
        [req.auth.branchId, periodDate]
      );
      if (existing[0]) return { error: "already_accrued" };

      const slips = await buildPayrollSlips(client, req.auth.branchId, period);
      if (!slips.length) return { error: "no_staff" };

      const gosiDue = roundMoney(slips.reduce((a, s) => a + s.gosiEmployee + s.gosiEmployer, 0));
      const netPayable = roundMoney(slips.reduce((a, s) => a + s.net, 0));
      const employerCost = roundMoney(slips.reduce((a, s) => a + s.employerCost, 0));
      const absent = roundMoney(slips.reduce((a, s) => a + s.absenceDeduction, 0));

      const lines = [];
      const push = (account, side, amount) => { if (amount > 0) lines.push({ account, side, amount }); };
      push("6710", "debit", roundMoney(slips.reduce((a, s) => a + s.basic, 0)));
      push("6720", "debit", roundMoney(slips.reduce((a, s) => a + s.housing, 0)));
      push("6730", "debit", roundMoney(slips.reduce((a, s) => a + s.transport + s.other, 0)));
      push("6760", "debit", roundMoney(slips.reduce((a, s) => a + s.commission, 0)));
      push("6740", "debit", roundMoney(slips.reduce((a, s) => a + s.gosiEmployer, 0)));
      push("6750", "debit", roundMoney(slips.reduce((a, s) => a + s.eosAccrual, 0)));
      push("2320", "credit", gosiDue);
      push("2350", "credit", roundMoney(slips.reduce((a, s) => a + s.advances, 0)));
      push("2330", "credit", roundMoney(slips.reduce((a, s) => a + s.eosAccrual, 0)));
      push("2310", "credit", netPayable);
      // ⚠ خصم الغياب يُنقص المصروف لا يزيد الإيراد — دائن على نفس حساب
      // الرواتب الأساسية (6710)، يطابق buildPayrollJournal.js حرفيًا.
      push("6710", "credit", absent);

      const ref = `PAY-${period}`;

      const journalEntryId = await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId: null,
        opType: "payroll_run",
        refTable: "payroll_runs",
        refId: null,
        description: `رواتب ${period}`,
        createdBy: req.auth.userId,
        lines,
      });

      const { rows: runRows } = await client.query(
        `insert into payroll_runs (branch_id, period, status, ref, gosi_due, journal_entry_id, created_by)
         values ($1,$2,'approved',$3,$4,$5,$6)
         returning *`,
        [req.auth.branchId, periodDate, ref, gosiDue, journalEntryId, req.auth.userId]
      );
      const run = runRows[0];

      for (const s of slips) {
        await client.query(
          `insert into payroll_lines
             (payroll_run_id, user_id, base_salary, housing, transport, other_allowance,
              gosi_employee, gosi_employer, commission, advances, absent_days,
              unpaid_leave_days, absence_deduction, eos_accrual, employer_cost, net_pay)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [
            run.id, s.employeeId, s.basic, s.housing, s.transport, s.other,
            s.gosiEmployee, s.gosiEmployer, s.commission, s.advances, s.absentDays,
            s.unpaidLeaveDays, s.absenceDeduction, s.eosAccrual, s.employerCost, s.net,
          ]
        );
      }

      // ⚠ السلف المستردّة تُوسَم كي لا تُخصم ثانيةً الشهر القادم — يطابق
      // تعليق handleAccruePayroll المرجعي حرفيًا.
      const settledIds = slips.flatMap((s) => s.advanceIds);
      if (settledIds.length) {
        await client.query(
          `update expenses set settled = true, settled_period = $1 where id = any($2::uuid[])`,
          [period, settledIds]
        );
      }

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'payroll_runs',$3,$4)`,
        [req.auth.branchId, req.auth.userId, run.id, JSON.stringify({ period, staff: slips.length, net: netPayable, cost: employerCost })]
      );

      return { run, netPayable, employerCost, staffCount: slips.length };
    });

    if (result.error === "already_accrued") return res.status(409).json({ error: "already_accrued" });
    if (result.error === "no_staff") return res.status(400).json({ error: "no_staff" });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/payroll/runs/:runId/pay/:employeeId", async (req, res, next) => {
  const fundingSource = req.body?.fundingSource;
  if (!CASH_ACCOUNTS[fundingSource]) return res.status(400).json({ error: "invalid_funding_source" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: runRows } = await client.query(
        `select * from payroll_runs where id = $1 and branch_id = $2`,
        [req.params.runId, req.auth.branchId]
      );
      const run = runRows[0];
      if (!run) return { error: "not_found" };

      const { rows: lineRows } = await client.query(
        `select * from payroll_lines where payroll_run_id = $1 and user_id = $2 for update`,
        [req.params.runId, req.params.employeeId]
      );
      const line = lineRows[0];
      if (!line) return { error: "not_found" };
      if (line.paid_at) return { error: "already_paid" };
      const net = Number(line.net_pay);
      if (!(net > 0)) return { error: "nothing_to_pay" };

      const { rows: userRows } = await client.query(`select name from users where id = $1`, [req.params.employeeId]);
      const empName = userRows[0]?.name || "";

      const businessDayId = await openDay(client, req.auth.branchId);
      const { pool, method, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
      await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,'out',$5,'salaries',$6,$7,$8,$9)`,
        [req.auth.branchId, businessDayId, pool, method, net, "payroll_lines", line.id, `راتب ${empName} — ${run.ref}`, req.auth.userId]
      );
      await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: "payroll_pay",
        refTable: "payroll_lines",
        refId: line.id,
        description: `صرف راتب ${empName} — ${run.ref}`,
        createdBy: req.auth.userId,
        lines: [
          { account: "2310", side: "debit", amount: net },
          { account: cashAccount, side: "credit", amount: net },
        ],
      });

      const { rows: updated } = await client.query(
        `update payroll_lines set paid_at = now(), paid_source = $1 where id = $2 returning *`,
        [fundingSource, line.id]
      );

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'payroll_lines',$3,$4)`,
        [req.auth.branchId, req.auth.userId, line.id, JSON.stringify({ action: "pay_salary", net, fundingSource })]
      );

      return { line: updated[0] };
    });

    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    if (result.error === "already_paid") return res.status(409).json({ error: "already_paid" });
    if (result.error === "nothing_to_pay") return res.status(400).json({ error: "nothing_to_pay" });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/payroll/runs/:runId/pay-gosi", requireManager, async (req, res, next) => {
  const fundingSource = req.body?.fundingSource;
  if (!CASH_ACCOUNTS[fundingSource]) return res.status(400).json({ error: "invalid_funding_source" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: runRows } = await client.query(
        `select * from payroll_runs where id = $1 and branch_id = $2 for update`,
        [req.params.runId, req.auth.branchId]
      );
      const run = runRows[0];
      if (!run) return { error: "not_found" };
      if (run.gosi_paid_at) return { error: "already_paid" };
      const due = Number(run.gosi_due);
      if (!(due > 0)) return { error: "nothing_to_pay" };

      const businessDayId = await openDay(client, req.auth.branchId);
      const { pool, method, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
      await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,'out',$5,'gosi',$6,$7,$8,$9)`,
        [req.auth.branchId, businessDayId, pool, method, due, "payroll_runs", run.id, `تأمينات ${run.ref}`, req.auth.userId]
      );
      await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: "gosi_pay",
        refTable: "payroll_runs",
        refId: run.id,
        description: `سداد التأمينات — ${run.ref}`,
        createdBy: req.auth.userId,
        lines: [
          { account: "2320", side: "debit", amount: due },
          { account: cashAccount, side: "credit", amount: due },
        ],
      });

      const { rows: updated } = await client.query(
        `update payroll_runs set gosi_paid_at = now(), gosi_paid_source = $1 where id = $2 returning *`,
        [fundingSource, run.id]
      );

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'payroll_runs',$3,$4)`,
        [req.auth.branchId, req.auth.userId, run.id, JSON.stringify({ action: "pay_gosi", due, fundingSource })]
      );

      return { run: updated[0] };
    });

    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    if (result.error === "already_paid") return res.status(409).json({ error: "already_paid" });
    if (result.error === "nothing_to_pay") return res.status(400).json({ error: "nothing_to_pay" });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * نهاية الخدمة — استحقاق يُحسب لحظيًا (لا جدول مستقل، يطابق المرجع
 * الذي يحسبه من hireDate/gross وقت الصرف فقط) ويُصرف من المخصّص
 * المتراكم فعليًا في 2330 (مجموع credit-debit لكل قيود gosi_pay/
 * eos_accrual على هذا الحساب)، والفرق (لو المخصّص أقل من المستحق —
 * موظف قديم قبل تفعيل الرواتب) يُحمَّل كمصروف إضافي على 6750 مباشرة،
 * تمامًا كـhandlePayEndOfService المرجعي.
 */
router.post("/payroll/eos", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const employeeId = body.employeeId;
  const reason = body.reason === "resignation" ? "resignation" : "termination";
  const atDate = body.atDate || new Date().toISOString().slice(0, 10);
  const fundingSource = body.fundingSource;
  if (!employeeId) return res.status(400).json({ error: "employee_required" });
  if (!CASH_ACCOUNTS[fundingSource]) return res.status(400).json({ error: "invalid_funding_source" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: userRows } = await client.query(
        `select * from users where id = $1 and branch_id = $2 for update`,
        [employeeId, req.auth.branchId]
      );
      const emp = userRows[0];
      if (!emp) return { error: "not_found" };
      if (!emp.active) return { error: "already_left" };

      const basic = roundMoney(emp.basic_salary || 0);
      const housing = emp.housing != null ? roundMoney(emp.housing) : roundMoney(basic * 0.25);
      const gross = roundMoney(basic + housing + roundMoney(emp.transport || 0) + roundMoney(emp.other_allowance || 0));

      const start = emp.hire_date ? new Date(emp.hire_date).getTime() : Date.now();
      const end = new Date(atDate).getTime();
      const years = Math.max(0, (end - start) / (365.25 * 86400000));
      const first5 = Math.min(years, 5);
      const after5 = Math.max(0, years - 5);
      let due = roundMoney(gross * 0.5 * first5 + gross * after5);
      if (reason === "resignation") {
        if (years < 2) due = 0;
        else if (years < 5) due = roundMoney(due / 3);
        else if (years < 10) due = roundMoney((due * 2) / 3);
      }
      if (!(due > 0)) return { error: "nothing_due", years: Math.round(years * 100) / 100 };

      // المخصّص المتراكم فعليًا على 2330 لكل الفرع — نفس منطق المرجع
      // (يجمعه من كل قيود اليومية بحساب 2330 لا من عمود تراكمي مستقل).
      const { rows: accruedRows } = await client.query(
        `select coalesce(sum(case when jl.side = 'credit' then jl.amount else -jl.amount end), 0)::numeric as accrued
           from journal_lines jl join journal_entries je on je.id = jl.entry_id
          where je.branch_id = $1 and jl.account_code = '2330'`,
        [req.auth.branchId]
      );
      const accrued = Math.max(0, Number(accruedRows[0].accrued));
      const fromProvision = Math.min(due, accrued);
      const topUp = roundMoney(due - fromProvision);

      const businessDayId = await openDay(client, req.auth.branchId);
      const { pool, method, account: cashAccount } = CASH_ACCOUNTS[fundingSource];
      await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,'out',$5,'eos',$6,$7,$8,$9)`,
        [req.auth.branchId, businessDayId, pool, method, due, "users", emp.id, `نهاية خدمة ${emp.name}`, req.auth.userId]
      );

      if (fromProvision > 0) {
        await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId, opType: "eos_pay",
          refTable: "users", refId: emp.id,
          description: `نهاية خدمة ${emp.name} — من المخصّص`,
          createdBy: req.auth.userId,
          lines: [
            { account: "2330", side: "debit", amount: fromProvision },
            { account: cashAccount, side: "credit", amount: fromProvision },
          ],
        });
      }
      if (topUp > 0) {
        await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId, opType: "eos_pay",
          refTable: "users", refId: emp.id,
          description: `نهاية خدمة ${emp.name} — ما فوق المخصّص`,
          createdBy: req.auth.userId,
          lines: [
            { account: "6750", side: "debit", amount: topUp },
            { account: cashAccount, side: "credit", amount: topUp },
          ],
        });
      }

      const { rows: updated } = await client.query(
        `update users set active = false, left_at = $1, leave_reason = $2, eos_paid = $3
          where id = $4
          returning id, name, ref, active, left_at, leave_reason, eos_paid`,
        [atDate, reason, due, emp.id]
      );

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'users',$3,$4)`,
        [req.auth.branchId, req.auth.userId, emp.id, JSON.stringify({ action: "eos", due, years: Math.round(years * 100) / 100, reason })]
      );

      return { user: updated[0], due, years: Math.round(years * 100) / 100 };
    });

    if (result.error === "not_found") return res.status(404).json({ error: "not_found" });
    if (result.error === "already_left") return res.status(409).json({ error: "already_left" });
    if (result.error === "nothing_due") return res.status(400).json({ error: "nothing_due", years: result.years });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
