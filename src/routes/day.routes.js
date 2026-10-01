import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireCanManageDay, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { closeBusinessDay } from "../domain/businessDay.js";
import { postPoolTransfer } from "../domain/cashPools.js";
import { approvalGate } from "../domain/approvals.js";
import { recordPendingApproval } from "../domain/saleGuards.js";

const router = Router();

/**
 * فتح/إقفال يوم العمل + عهدة الصندوق اليومي — الفجوة الحقيقية الأكبر
 * المتبقية عند بدء هذا الملف: business_days (schema.sql) كان جدولًا بلا
 * أي INSERT/UPDATE في كامل الباك إند — كل route كان *يقرأ* اليوم المفتوح
 * فقط ليختم به سجلاته، فقاعدة بيانات جديدة لا يمكنها معالجة أي بيع إطلاقًا
 * (409 no_open_business_day دائمًا). راجع تعليق migration 008 للتفصيل.
 *
 * ⚠ نطاق متعمَّد: "الربح" في لقطة الإقفال (المرجع: saleProfitOf، يحتاج
 * تكلفة كل صنف + نصيب مصنعية الدفعة) يبقى محسوبًا في الفرونت إند من نفس
 * بيانات bootstrap (sales+items) المخزَّنة أصلًا لديه — لا يُعاد بناؤه
 * هنا. لقطة الإقفال هنا تقتصر على ما يُشتق مباشرة ورخيصًا من دفاتر
 * الحركة (عدّ/مجموع/رصيد لحظي)، تمامًا كفلسفة safe_audits.
 */
router.use(["/day", "/custody"], authenticate, requirePage("workday"));

async function findOpenDay(client, branchId) {
  const { rows } = await client.query(
    `select * from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0] || null;
}

async function findOpenCustody(client, branchId) {
  const { rows } = await client.query(
    `select * from daily_custody where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0] || null;
}

// ── فتح يوم عمل جديد — يفتح عهدة صندوق يومي كأثر جانبي إن مرّرت أي عربون ──
//
// ⚠ يطابق handleOpenBusinessDay: التحويل من الخزنة لتمويل العربون (نقد
// الصندوق اليومي + عهدة الكسر) سطرا cash_tx، ومعهما قيد «تحويل بين
// الصناديق» (مدين الوجهة/دائن المصدر — migration 044) كي يطابق الأستاذ الصناديق.
router.post("/day/open", requireCanManageDay, requireNotDenied("openDay"), async (req, res, next) => {
  const body = req.body || {};
  const tillFloat = roundMoney(body.tillFloat) || 0;
  const scrapFloat = roundMoney(body.scrapFloat) || 0;
  const note = body.note || null;
  if (tillFloat < 0 || scrapFloat < 0) {
    return res.status(400).json({ error: "invalid_float_amount" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const already = await findOpenDay(client, req.auth.branchId);
      if (already) return { error: "day_already_open", ref: already.ref };

      const totalFloat = roundMoney(tillFloat + scrapFloat);
      if (totalFloat > 0) {
        const { rows: safeRows } = await client.query(
          `select coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
             from cash_tx where branch_id = $1 and pool = 'safe' and method = 'cash'`,
          [req.auth.branchId]
        );
        const safeCash = Number(safeRows[0]?.balance) || 0;
        if (totalFloat > safeCash + 0.01) {
          return { error: "insufficient_safe_cash", available: safeCash, requested: totalFloat };
        }
      }

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from business_days where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `DAY-${String(refRows[0].n).padStart(3, "0")}`;

      const { rows: dayRows } = await client.query(
        `insert into business_days
           (branch_id, ref, status, till_float, scrap_float, opened_by, note)
         values ($1,$2,'open',$3,$4,$5,$6)
         returning *`,
        [req.auth.branchId, ref, tillFloat, scrapFloat, req.auth.userId, note]
      );
      const day = dayRows[0];

      // ── عربون الصندوق اليومي: خزنة → صندوق يومي، ويفتح عهدة صندوق ──
      let custody = null;
      if (tillFloat > 0) {
        const { rows: tillOut } = await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
           values ($1,$2,'safe','cash','out',$3,'transfer_to_daily',$4,$5) returning id`,
          [req.auth.branchId, day.id, tillFloat, `عربون افتتاح ${ref}`, req.auth.userId]
        );
        await postPoolTransfer(client, {
          branchId: req.auth.branchId, businessDayId: day.id, from: "safe", to: "daily", method: "cash",
          amount: tillFloat, outTxId: tillOut[0].id, description: `عربون افتتاح ${ref}`, createdBy: req.auth.userId,
        });
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
           values ($1,$2,'daily','cash','in',$3,'transfer_from_safe',$4,$5)`,
          [req.auth.branchId, day.id, tillFloat, `عربون افتتاح ${ref}`, req.auth.userId]
        );
      }
      const { rows: custRefRows } = await client.query(
        `select count(*)::int + 1 as n from daily_custody where branch_id = $1`,
        [req.auth.branchId]
      );
      const custRef = `CUS-${String(custRefRows[0].n).padStart(6, "0")}`;
      const { rows: custRows } = await client.query(
        `insert into daily_custody
           (branch_id, ref, business_day_id, status, float_cash, float_network, opened_by, note)
         values ($1,$2,$3,'open',$4,0,$5,$6)
         returning *`,
        [req.auth.branchId, custRef, day.id, tillFloat, req.auth.userId, note]
      );
      custody = custRows[0];

      // ── عربون عهدة الكسر: خزنة → عهدة الكسر ──
      if (scrapFloat > 0) {
        const { rows: scrapOut } = await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
           values ($1,$2,'safe','cash','out',$3,'transfer_to_custody',$4,$5) returning id`,
          [req.auth.branchId, day.id, scrapFloat, `عربون افتتاح ${ref}`, req.auth.userId]
        );
        await postPoolTransfer(client, {
          branchId: req.auth.branchId, businessDayId: day.id, from: "safe", to: "custody", method: "cash",
          amount: scrapFloat, outTxId: scrapOut[0].id, description: `عربون عهدة الكسر ${ref}`, createdBy: req.auth.userId,
        });
        await client.query(
          `insert into scrap_custody (branch_id, business_day_id, direction, amount, note, created_by)
           values ($1,$2,'in',$3,$4,$5)`,
          [req.auth.branchId, day.id, scrapFloat, `عربون افتتاح ${ref}`, req.auth.userId]
        );
      }

      return { day, custody };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── إقفال يوم العمل — لقطة لحظية، لا يمنعها كسر معلَّق (تنبيهي فقط) ──
router.post("/day/close", requireCanManageDay, requireNotDenied("closeDay"), async (req, res, next) => {
  const note = req.body?.note || null;

  try {
    const result = await withBranch(req.auth.branchId, (client) =>
      closeBusinessDay(client, req.auth.branchId, { closedBy: req.auth.userId, note })
    );
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── إنهاء اليوم فعلٌ واحد (المرجع ت٢ — handleEndOfDay) ──
//
// عدٌّ إلزامي ← فرقه (فوق حدّ «فرق العدّ» يعتمده غير من عدّ) ← التوريد بالمعدود إلى الخزنة ← إقفال العهدة واليوم.
// في معاملةٍ واحدة: لا يُقفل يومٌ بصندوقٍ لم يُعدّ، ولا يبقى نصف إقفال. العدّ «أعمى» في الواجهة: من يعدّ لا يرى المتوقَّع.
router.post("/day/end", requireCanManageDay, requireNotDenied("closeDay"), async (req, res, next) => {
  const body = req.body || {};
  if (body.countedCash == null || body.countedCash === "") return res.status(400).json({ error: "count_required" });
  const countedCash = roundMoney(body.countedCash) || 0;
  const countedNetwork = roundMoney(body.countedNetwork) || 0;
  const sweep = body.sweep !== false;
  const note = body.note || null;
  if (countedCash < 0 || countedNetwork < 0) return res.status(400).json({ error: "invalid_count" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const day = await findOpenDay(client, req.auth.branchId);
      if (!day) return { error: "no_open_business_day" };
      const { rows: cashRows } = await client.query(
        `select method, coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
           from cash_tx where branch_id = $1 and pool = 'daily' group by method`, [req.auth.branchId]);
      const expectedCash = roundMoney(Number(cashRows.find((r) => r.method === "cash")?.balance) || 0);
      const expectedNetwork = roundMoney(Number(cashRows.find((r) => r.method === "network")?.balance) || 0);
      const varianceCash = roundMoney(countedCash - expectedCash);
      const varianceNetwork = roundMoney(countedNetwork - expectedNetwork);
      const varianceAbs = roundMoney(Math.abs(varianceCash) + Math.abs(varianceNetwork));

      // ⚖ الفرق فوق الحدّ (100 افتراضًا) يمرّ ببوّابة الاعتماد — لا يعتمده من عدّ
      const gate = varianceAbs >= 0.01
        ? await approvalGate(client, req.auth, {
          kind: "count_variance", amount: varianceAbs, approvalId: body.approvalId || null,
          note: `فرق عدّ الصندوق ${day.ref}: نقد ${varianceCash} · شبكة ${varianceNetwork}`,
          payload: { ...body, approvalId: undefined },
        })
        : { proceed: true };
      if (gate.error) return gate;
      if (gate.pending) {
        return { error: "approval_pending", request: { kind: "count_variance", amount: varianceAbs,
          note: `فرق عدّ الصندوق ${day.ref}: نقد ${varianceCash} · شبكة ${varianceNetwork}`, payload: { ...body, approvalId: undefined } } };
      }

      // ① العهدة: تُقفل بالمعدود، والفرق تسويةٌ نقدية بقيدها (4330 زيادة · 5330 عجز)
      const custody = await findOpenCustody(client, req.auth.branchId);
      if (custody) {
        await client.query(
          `update daily_custody set status = 'closed', closed_by = $1, closed_at = now(), close_note = $2,
             counted_cash = $3, counted_network = $4, expected_cash = $5, expected_network = $6,
             variance_cash = $7, variance_network = $8 where id = $9`,
          [req.auth.userId, note, countedCash, countedNetwork, expectedCash, expectedNetwork, varianceCash, varianceNetwork, custody.id]);
      }
      const journalEntryIds = [];
      for (const [method, variance, cashAccount] of [["cash", varianceCash, "1130"], ["network", varianceNetwork, "1140"]]) {
        if (Math.abs(variance) < 0.01) continue;
        const isSurplus = variance > 0;
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily',$3,$4,$5,$6,'business_days',$7,$8,$9)`,
          [req.auth.branchId, day.id, method, isSurplus ? "in" : "out", Math.abs(variance), isSurplus ? "cash_surplus" : "cash_shortage",
            day.id, `${isSurplus ? "زيادة" : "عجز"} بعدّ إنهاء اليوم — ${day.ref}`, req.auth.userId]);
        journalEntryIds.push(await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId: day.id, opType: isSurplus ? "cash_surplus" : "cash_shortage",
          refTable: "business_days", refId: day.id, createdBy: req.auth.userId,
          description: `${isSurplus ? "زيادة" : "عجز"} بعدّ إنهاء اليوم (${method}) — ${day.ref}`,
          lines: isSurplus
            ? [{ account: cashAccount, side: "debit", amount: Math.abs(variance) }, { account: "4330", side: "credit", amount: Math.abs(variance) }]
            : [{ account: "5330", side: "debit", amount: Math.abs(variance) }, { account: cashAccount, side: "credit", amount: Math.abs(variance) }],
        }));
      }

      // ② التوريد بالمعدود: الصندوق اليومي ← الخزنة (نقدًا وشبكة)، فيبدأ الغد من صفر
      const swept = { cash: 0, network: 0 };
      if (sweep) {
        for (const [method, amount] of [["cash", countedCash], ["network", countedNetwork]]) {
          if (!(amount > 0)) continue;
          const { rows: out } = await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
             values ($1,$2,'daily',$3,'out',$4,'transfer_to_safe',$5,$6) returning id`,
            [req.auth.branchId, day.id, method, amount, `توريد إنهاء اليوم ${day.ref}`, req.auth.userId]);
          await client.query(
            `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
             values ($1,$2,'safe',$3,'in',$4,'transfer_from_daily',$5,$6)`,
            [req.auth.branchId, day.id, method, amount, `توريد إنهاء اليوم ${day.ref}`, req.auth.userId]);
          journalEntryIds.push(await postPoolTransfer(client, {
            branchId: req.auth.branchId, businessDayId: day.id, from: "daily", to: "safe", method, amount,
            outTxId: out[0].id, description: `توريد إنهاء اليوم ${day.ref}`, createdBy: req.auth.userId,
          }));
          swept[method] = amount;
        }
      }

      // ③ إقفال اليوم بلقطته
      const closed = await closeBusinessDay(client, req.auth.branchId, { closedBy: req.auth.userId, note });
      if (closed.error) return closed;
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'close',$2,'business_days',$3,$4)`,
        [req.auth.branchId, req.auth.userId, day.id, JSON.stringify({ ref: day.ref, endOfDay: true, countedCash, countedNetwork,
          expectedCash, expectedNetwork, varianceCash, varianceNetwork, swept, approvalId: gate.approvalId || null })]);
      return { ...closed, count: { countedCash, countedNetwork, expectedCash, expectedNetwork, varianceCash, varianceNetwork }, swept, journalEntryIds: journalEntryIds.filter(Boolean) };
    });
    if (result.error === "approval_pending") return recordPendingApproval(res, req.auth, result.request);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── فتح عهدة صندوق يومي مستقلة (مناوبة جديدة دون فتح يوم عمل جديد) ──
router.post("/custody/open", requireCanManageDay, async (req, res, next) => {
  const body = req.body || {};
  const floatCash = roundMoney(body.floatCash) || 0;
  const floatNetwork = roundMoney(body.floatNetwork) || 0;
  const note = body.note || null;
  if (floatCash < 0 || floatNetwork < 0) {
    return res.status(400).json({ error: "invalid_float_amount" });
  }

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const already = await findOpenCustody(client, req.auth.branchId);
      if (already) return { error: "custody_already_open", ref: already.ref };

      const day = await findOpenDay(client, req.auth.branchId);
      if (!day) return { error: "no_open_business_day" };

      for (const [method, amount] of [["cash", floatCash], ["network", floatNetwork]]) {
        if (amount <= 0) continue;
        const { rows: safeRows } = await client.query(
          `select coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
             from cash_tx where branch_id = $1 and pool = 'safe' and method = $2`,
          [req.auth.branchId, method]
        );
        if (amount > (Number(safeRows[0]?.balance) || 0) + 0.01) {
          return { error: "insufficient_safe_cash", method, available: Number(safeRows[0]?.balance) || 0, requested: amount };
        }
        const { rows: floatOut } = await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
           values ($1,$2,'safe',$3,'out',$4,'transfer_to_daily',$5,$6) returning id`,
          [req.auth.branchId, day.id, method, amount, note || "فتح عهدة الصندوق اليومي", req.auth.userId]
        );
        await postPoolTransfer(client, {
          branchId: req.auth.branchId, businessDayId: day.id, from: "safe", to: "daily", method,
          amount, outTxId: floatOut[0].id, description: note || "فتح عهدة الصندوق اليومي", createdBy: req.auth.userId,
        });
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
           values ($1,$2,'daily',$3,'in',$4,'transfer_from_safe',$5,$6)`,
          [req.auth.branchId, day.id, method, amount, note || "فتح عهدة الصندوق اليومي", req.auth.userId]
        );
      }

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from daily_custody where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `CUS-${String(refRows[0].n).padStart(6, "0")}`;
      const { rows: custRows } = await client.query(
        `insert into daily_custody
           (branch_id, ref, business_day_id, status, float_cash, float_network, opened_by, note)
         values ($1,$2,$3,'open',$4,$5,$6,$7)
         returning *`,
        [req.auth.branchId, ref, day.id, floatCash, floatNetwork, req.auth.userId, note]
      );
      return { custody: custRows[0] };
    });
    if (result.error) {
      const status = result.error === "no_open_business_day" ? 409 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── إقفال عهدة الصندوق اليومي — عدّ فعلي، والفرق يُرحَّل تسويةً نقدية ──
//
// ⚠ يطابق handleCloseDailyCustody + فلسفة /safe/audit: "المتوقَّع" رصيد
// الصندوق اليومي الحالي (لا رصيد العهدة عند فتحها) — البائع قد يكون
// حصَّل مبيعات إضافية بعد الفتح، والمتوقَّع يعكس كل ما جرى منذ الفتح لا
// العربون وحده.
router.post("/custody/close", requireCanManageDay, async (req, res, next) => {
  const body = req.body || {};
  const countedCash = roundMoney(body.countedCash) || 0;
  const countedNetwork = roundMoney(body.countedNetwork) || 0;
  const note = body.note || null;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const custody = await findOpenCustody(client, req.auth.branchId);
      if (!custody) return { error: "no_open_custody" };

      const { rows: cashRows } = await client.query(
        `select method, coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
           from cash_tx where branch_id = $1 and pool = 'daily' group by method`,
        [req.auth.branchId]
      );
      const expectedCash = Number(cashRows.find((r) => r.method === "cash")?.balance) || 0;
      const expectedNetwork = Number(cashRows.find((r) => r.method === "network")?.balance) || 0;
      const varianceCash = roundMoney(countedCash - expectedCash);
      const varianceNetwork = roundMoney(countedNetwork - expectedNetwork);

      const { rows: updRows } = await client.query(
        `update daily_custody set
           status = 'closed', closed_by = $1, closed_at = now(), close_note = $2,
           counted_cash = $3, counted_network = $4,
           expected_cash = $5, expected_network = $6,
           variance_cash = $7, variance_network = $8
         where id = $9
         returning *`,
        [req.auth.userId, note, countedCash, countedNetwork, expectedCash, expectedNetwork, varianceCash, varianceNetwork, custody.id]
      );

      // ── فرق العدّ يُرحَّل تسويةً نقدية على صندوق اليوم، بنفس أزواج
      // حسابات cash_surplus/cash_shortage المستخدَمة أصلًا في /safe/audit
      // — الفرق هنا فرق "صندوق يومي" (1130/1140) لا "خزنة" فقط باختلاف pool.
      const journalEntryIds = [];
      for (const [method, variance, cashAccount] of [
        ["cash", varianceCash, "1130"],
        ["network", varianceNetwork, "1140"],
      ]) {
        if (Math.abs(variance) < 0.01) continue;
        const isSurplus = variance > 0;
        await client.query(
          `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'daily',$3,$4,$5,$6,'daily_custody',$7,$8,$9)`,
          [
            req.auth.branchId, custody.business_day_id, method, isSurplus ? "in" : "out", Math.abs(variance),
            isSurplus ? "cash_surplus" : "cash_shortage", custody.id,
            `${isSurplus ? "زيادة" : "عجز"} بعدّ العهدة اليومية — ${custody.ref}`, req.auth.userId,
          ]
        );
        const jid = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId: custody.business_day_id,
          opType: isSurplus ? "cash_surplus" : "cash_shortage",
          refTable: "daily_custody",
          refId: custody.id,
          description: `${isSurplus ? "زيادة" : "عجز"} بعدّ العهدة اليومية (${method}) — ${custody.ref}`,
          createdBy: req.auth.userId,
          lines: isSurplus
            ? [{ account: cashAccount, side: "debit", amount: Math.abs(variance) }, { account: "4330", side: "credit", amount: Math.abs(variance) }]
            : [{ account: "5330", side: "debit", amount: Math.abs(variance) }, { account: cashAccount, side: "credit", amount: Math.abs(variance) }],
        });
        journalEntryIds.push(jid);
      }

      return { custody: updRows[0], journalEntryIds };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
