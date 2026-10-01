import { Router } from "express";
import { approvalGate } from "../domain/approvals.js";
import { recordPendingApproval } from "../domain/saleGuards.js";
import { withBranch } from "../db.js";
import {
  authenticate,
  requirePage,
  requireCanManageDay,
  requireManager,
  requireNotDenied,
} from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { poolBalance, postPoolTransfer } from "../domain/cashPools.js";

const router = Router();

const KARATS = [24, 22, 21, 18, 14];

/**
 * عمليات الخزنة المستقلة (تحويلات نقد، تمويل عهدة الكسر، حركة ذهب يدوية،
 * جرد الخزنة) — كلها تعيش تحت تبويب "cash" في المرجع
 * (`CashTab`/`onTransferToSafe`/`onFundCustody`/`onAddSafeGold`/...)، فكل
 * routes هذا الملف تُفرض عليها `requirePage("cash")` أولًا، بصلاحيات
 * إضافية أدق لكل عملية.
 *
 * ⚠ ملاحظة بنيوية: عكس المرجع (ثلاث مصفوفات منفصلة cashTx/safeTx/
 * scrapCustodyTx)، عندنا جدول موحّد `cash_tx` بعمود `pool` ('safe'|
 * 'daily'|'custody') — فالتحويل بين صندوقين هنا سطران في نفس الجدول
 * (خروج من صندوق، دخول لآخر)، لا كتابة لمصفوفتين منفصلتين.
 *
 * التحويلات الداخلية (transfer_to_safe/transfer_to_daily/transfer_to_custody)
 * تُرحَّل الآن قيدَ «تحويل بين الصناديق» (مدين الوجهة/دائن المصدر) — المرجع
 * 5.2.0 أصلح الشيء نفسه (float_in/float_out): بلا قيد يبقى 1130 ممتلئًا
 * و1110 ناقصًا في الأستاذ بعد كل توريد، فلا يطابق الأستاذُ الصناديقَ.
 * والتحويل لا يتجاوز رصيد صندوقه المصدر.
 */
router.use("/safe", authenticate, requirePage("cash"));

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
      order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

// ── تحويل من الصندوق اليومي إلى الخزنة ──
router.post("/safe/transfer-to-safe", requireNotDenied("cashMove"), async (req, res, next) => {
  const amount = roundMoney(req.body?.amount);
  const method = req.body?.method === "network" ? "network" : "cash";
  const note = req.body?.note || null;
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);
      const available = await poolBalance(client, req.auth.branchId, "daily", method);
      if (amount > available + 0.005) return { error: "insufficient_pool_balance", available };
      const { rows: outRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
         values ($1,$2,'daily',$3,'out',$4,$5,$6,$7)
         returning *`,
        [req.auth.branchId, businessDayId, method, amount, "transfer_to_safe", note || "تحويل إلى الخزنة", req.auth.userId]
      );
      const { rows: inRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, ref_table, ref_id, created_by)
         values ($1,$2,'safe',$3,'in',$4,'transfer_from_daily',$5,'cash_tx',$6,$7)
         returning *`,
        [req.auth.branchId, businessDayId, method, amount, note || "تحويل من الصندوق اليومي", outRows[0].id, req.auth.userId]
      );
      await postPoolTransfer(client, {
        branchId: req.auth.branchId, businessDayId, from: "daily", to: "safe", method, amount,
        outTxId: outRows[0].id, description: note || "توريد من الصندوق اليومي إلى الخزنة", createdBy: req.auth.userId,
      });
      // ⚠ إضافة لخدمة الفرونت إند المُحوَّل: يحتاج سطري cash_tx فعليًا لتحديث
      // الحالة المحلية بلا إعادة تحميل bootstrap كاملة بعد كل عملية خزنة.
      return { ok: true, dailyTx: outRows[0], safeTx: inRows[0] };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── تحويل من الخزنة إلى الصندوق اليومي ──
router.post("/safe/transfer-to-daily", requireNotDenied("cashMove"), async (req, res, next) => {
  const amount = roundMoney(req.body?.amount);
  const method = req.body?.method === "network" ? "network" : "cash";
  const note = req.body?.note || null;
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);
      const available = await poolBalance(client, req.auth.branchId, "safe", method);
      if (amount > available + 0.005) return { error: "insufficient_pool_balance", available };
      const { rows: outRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
         values ($1,$2,'safe',$3,'out',$4,'transfer_to_daily',$5,$6)
         returning *`,
        [req.auth.branchId, businessDayId, method, amount, note || "تحويل إلى الصندوق اليومي", req.auth.userId]
      );
      const { rows: inRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, ref_table, ref_id, created_by)
         values ($1,$2,'daily',$3,'in',$4,'transfer_from_safe',$5,'cash_tx',$6,$7)
         returning *`,
        [req.auth.branchId, businessDayId, method, amount, note || "تحويل من الخزنة", outRows[0].id, req.auth.userId]
      );
      await postPoolTransfer(client, {
        branchId: req.auth.branchId, businessDayId, from: "safe", to: "daily", method, amount,
        outTxId: outRows[0].id, description: note || "تحويل من الخزنة إلى الصندوق اليومي", createdBy: req.auth.userId,
      });
      return { ok: true, safeTx: outRows[0], dailyTx: inRows[0] };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── تمويل عهدة الكسر (من الصندوق اليومي أو الخزنة) — handleFundCustody ──
router.post("/safe/fund-custody", requireNotDenied("cashMove"), async (req, res, next) => {
  const amount = roundMoney(req.body?.amount);
  const method = req.body?.method === "network" ? "network" : "cash";
  const source = req.body?.source === "safe" ? "safe" : "daily";
  const note = req.body?.note || null;
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);
      const available = await poolBalance(client, req.auth.branchId, source, method);
      if (amount > available + 0.005) return { error: "insufficient_pool_balance", available };
      const { rows: outRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
         values ($1,$2,$3,$4,'out',$5,'transfer_to_custody',$6,$7)
         returning *`,
        [req.auth.branchId, businessDayId, source, method, amount, note || "تحويل إلى عهدة الكسر", req.auth.userId]
      );
      // ⚠ فرق طفيف عن المرجع لمصلحة الدقة: handleFundCustody يُثبّت
      // category جانب العهدة على "transfer_from_daily" دائمًا حتى لو كان
      // المصدر "الخزنة" (نسخ-لصق واضح، بلا أثر محاسبي فعلي لأن هذي
      // التصنيفات لا تُترجم لحساب في CATEGORY_TO_ACCOUNT أصلًا). هنا
      // نستخدم التصنيف المطابق فعليًا للمصدر.
      const { rows: inRows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, ref_table, ref_id, created_by)
         values ($1,$2,'custody',$3,'in',$4,$5,$6,'cash_tx',$7,$8)
         returning *`,
        [
          req.auth.branchId, businessDayId, method, amount,
          source === "safe" ? "transfer_from_safe" : "transfer_from_daily",
          note || "تمويل عهدة الكسر", outRows[0].id, req.auth.userId,
        ]
      );
      await postPoolTransfer(client, {
        branchId: req.auth.branchId, businessDayId, from: source, to: "custody", method, amount,
        outTxId: outRows[0].id, description: note || "تمويل عهدة الكسر", createdBy: req.auth.userId,
      });
      return { ok: true, sourceTx: outRows[0], custodyTx: inRows[0], source };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── حركة نقد يدوية مباشرة في الخزنة (إيداع/سحب) — handleAddSafeTx ──
router.post("/safe/cash", requireNotDenied("safeMove"), async (req, res, next) => {
  const type = req.body?.type === "out" ? "out" : "in";
  const amount = roundMoney(req.body?.amount);
  const method = req.body?.method === "network" ? "network" : "cash";
  const category = req.body?.category || "manual";
  const note = req.body?.note || (type === "in" ? "إيداع يدوي" : "سحب يدوي");
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);
      const { rows } = await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note, created_by)
         values ($1,$2,'safe',$3,$4,$5,$6,$7,$8)
         returning *`,
        [req.auth.branchId, businessDayId, method, type, amount, category, note, req.auth.userId]
      );
      return { ok: true, safeTx: rows[0] };
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// ── حركة ذهب يدوية مباشرة في الخزنة (إيداع/سحب) — handleAddSafeGoldTx ──
//
// ⚠ إصلاحان حقيقيان بعد سؤالك الصريح مقارنة بالمرجع:
// 1. صلاحية: handleAddSafeGoldTx بلا أي تحقق دور إطلاقًا في المرجع — هنا
//    نطبّق "مدير + مساعد" (نفس نمط can_manage_day، بقرارك).
// 2. سداد مورد بذهب خام من الخزنة (destination='supplier') في المرجع لا
//    يُرحّل أي قيد لدفتر الوزن (بعكس handleSettleSupplier's المسار
//    المطابق فعليًا لنفس الفعل، الذي يستدعي postWeight بشكل صحيح) — هنا
//    نُرحّل دائمًا: دفتر وزن + سطر supplier_ledger (تخفيض).
router.post("/safe/gold", requireCanManageDay, requireNotDenied("safeMove"), async (req, res, next) => {
  const body = req.body || {};
  const type = body.type === "out" ? "out" : "in";
  const kind = body.kind === "crafted" ? "crafted" : "raw";
  const karat = Number(body.karat);
  const weight = roundWeight(body.weight);
  const note = body.note || null;
  const destination = body.destination || null;
  const supplierId = body.supplierId || null;
  const officeId = body.officeId || null;

  if (!KARATS.includes(karat) || !(weight > 0)) {
    return res.status(400).json({ error: "invalid_karat_or_weight" });
  }
  if (type === "out") {
    // ⚠ "الوجهة إجبارية — سحب بلا وجهة يضيع أثره" — نص تعليق
    // safe_gold_out في posting_rules نفسه، مطبَّق هنا فعليًا (بعكس
    // اعتماد المرجع على التحقق الأمامي في SafeGoldForm فقط).
    const validDest = kind === "crafted"
      ? ["display", "repair", "other"]
      : ["supplier", "taskir", "refine", "other"];
    if (!validDest.includes(destination)) {
      return res.status(400).json({ error: "destination_required", allowed: validDest });
    }
    if (destination === "supplier" && !supplierId) {
      return res.status(400).json({ error: "supplier_required" });
    }
    if (destination === "taskir" && !officeId) {
      return res.status(400).json({ error: "office_required" });
    }
  }

  // الحساب المستهدَف: 1220 للذهب الخام، 1210 للمشغول — مطابقةً لكون 1210
  // هو حساب "ذهب مشغول جاهز للبيع" الوحيد في الشجرة، وهو نفس ما تفترضه
  // WEIGHT_ACCOUNTS (تقبل 1210 و1220 معًا). المرجع لا يميّز الحسابين
  // إطلاقًا في posting_rules (safe_gold_in/out تستهدف 1220 دائمًا بلا
  // شرط kind) — هذا امتداد طبيعي لتغطية kind='crafted' الذي كان موجودًا
  // في الشكل لكن بلا ترحيل فعلي في المرجع أصلًا.
  const account = kind === "raw" ? "1220" : "1210";

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      if (destination === "supplier") {
        const { rows } = await client.query(
          "select id, name from suppliers where id = $1 and branch_id = $2",
          [supplierId, req.auth.branchId]
        );
        if (!rows[0]) return { error: "supplier_not_found" };
      }
      if (destination === "taskir") {
        const { rows } = await client.query(
          "select id, name from taskir_offices where id = $1 and branch_id = $2",
          [officeId, req.auth.branchId]
        );
        if (!rows[0]) return { error: "office_not_found" };
      }

      const businessDayId = await openDay(client, req.auth.branchId);

      const { rows: txRows } = await client.query(
        `insert into safe_gold_tx
           (branch_id, business_day_id, direction, karat, weight, kind, destination, supplier_id, office_id, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id`,
        [req.auth.branchId, businessDayId, type, karat, weight, kind, destination, supplierId, officeId, note, req.auth.userId]
      );
      const txId = txRows[0].id;

      await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight,
            from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,$5,$6, $7,$8, 'safe_gold_tx',$9,$10,$11)`,
        [
          req.auth.branchId, businessDayId, type === "in" ? "safe_gold_in" : "safe_gold_out",
          karat, weight, fineWeight(weight, karat),
          type === "in" ? null : account, type === "in" ? account : null,
          txId, note || (type === "in" ? "إيداع ذهب بالخزنة" : "سحب ذهب من الخزنة"), req.auth.userId,
        ]
      );

      let supplierLedgerId = null;
      if (destination === "supplier") {
        const { rows: slRows } = await client.query(
          `insert into supplier_ledger
             (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'decrease',$4,0,'safe_gold_tx',$5,$6,$7)
           returning id`,
          [req.auth.branchId, supplierId, businessDayId, fineWeight(weight, karat), txId, `سداد بذهب خام من الخزنة${note ? " — " + note : ""}`, req.auth.userId]
        );
        supplierLedgerId = slRows[0].id;
      }

      let officeLedgerId = null;
      if (destination === "taskir") {
        const { rows: olRows } = await client.query(
          `insert into taskir_office_tx
             (branch_id, office_id, business_day_id, direction, weight, karat, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,'out',$4,$5,'safe_gold_tx',$6,$7,$8)
           returning id`,
          [req.auth.branchId, officeId, businessDayId, weight, karat, txId, `تسكير بذهب خام من الخزنة${note ? " — " + note : ""}`, req.auth.userId]
        );
        officeLedgerId = olRows[0].id;
      }

      return { safeGoldTx: { id: txId, type, kind, karat, weight, destination }, supplierLedgerId, officeLedgerId };
    });
    if (result.error) return res.status(404).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * جرد الخزنة (نقد + شبكة + ذهب لكل عيار) — handleSafeAudit.
 *
 * ⚠ إصلاح حقيقي بعد سؤالك: SafeAuditPage في المرجع تقرأ
 * safeBalance.byKarat/.fineWeight، لكن الكائن المُمرَّر لها (safeBalance)
 * كائن نقد فقط {cash,network,total} — فحقول جرد الذهب لا تظهر إطلاقًا في
 * الواجهة، ومسار جرد الذهب معطَّل بالكامل عمليًا. هنا "المسجَّل حاليًا"
 * لكل عيار يُحسب صحيحًا من safe_gold_tx نفسه (ما يعادل
 * safeGoldBalance.byKarat في المرجع)، لا من دفتر النقد.
 *
 * ⚠ العدّ لكل عيار هنا رقم واحد يجمع الخام والمشغول معًا (raw+crafted) —
 * تمامًا كشكل واجهة المرجع الأصلية (خانة عدّ واحدة لكل عيار، لا فصل بين
 * النوعين) — فرق الوزن يُرحَّل لحساب 1220 (الذهب الخام بالخزنة) دائمًا،
 * مطابقةً لكون posting_rules.safe_gold_in/out تستهدف 1220 بلا شرط kind
 * أصلًا في المرجع نفسه.
 */
router.post("/safe/audit", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const countedCash = roundMoney(body.countedCash);
  const countedNetwork = roundMoney(body.countedNetwork);
  const goldCounts = body.gold && typeof body.gold === "object" ? body.gold : {};
  const note = body.note || null;

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);

      const { rows: cashRows } = await client.query(
        `select method,
                coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
           from cash_tx where branch_id = $1 and pool = 'safe'
          group by method`,
        [req.auth.branchId]
      );
      const shownCash = Number(cashRows.find((r) => r.method === "cash")?.balance) || 0;
      const shownNetwork = Number(cashRows.find((r) => r.method === "network")?.balance) || 0;
      const varianceCash = roundMoney(countedCash - shownCash);
      const varianceNetwork = roundMoney(countedNetwork - shownNetwork);

      const { rows: goldRows } = await client.query(
        `select karat,
                coalesce(sum(case when direction='in' then weight else -weight end), 0) as balance
           from safe_gold_tx where branch_id = $1
          group by karat`,
        [req.auth.branchId]
      );
      const shownByKarat = new Map(goldRows.map((r) => [r.karat, Number(r.balance)]));

      const goldLines = [];
      for (const [karatStr, countedRaw] of Object.entries(goldCounts)) {
        const karat = Number(karatStr);
        const counted = roundWeight(countedRaw);
        if (!KARATS.includes(karat)) continue;
        const shown = shownByKarat.get(karat) || 0;
        const variance = roundWeight(counted - shown);
        if (counted > 0 || Math.abs(variance) > 0.0005) {
          goldLines.push({ karat, counted, shown, variance });
        }
      }

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from safe_audits where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `SFA-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: auditRows } = await client.query(
        `insert into safe_audits
           (branch_id, ref, business_day_id, counted_cash, counted_network, diff_cash, diff_network,
            counted_gold, diff_gold, gold_lines, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12)
         returning id, ref`,
        [
          req.auth.branchId, ref, businessDayId, countedCash, countedNetwork, varianceCash, varianceNetwork,
          goldLines.reduce((a, l) => a + l.counted, 0), goldLines.reduce((a, l) => a + l.variance, 0),
          JSON.stringify(goldLines), note, req.auth.userId,
        ]
      );
      const audit = auditRows[0];

      // ⚖ قيمة فرق الذهب بمتوسط تكلفة الجرام الصافي في 1220 (رصيده المالي ÷ وزنه)، وبلا رصيدٍ بسعر اليوم
      const { rows: bookRows } = await client.query(
        `select coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as amount
           from journal_lines l join journal_entries e on e.id = l.entry_id
          where e.branch_id = $1 and l.account_code = '1220'`, [req.auth.branchId]);
      const { rows: fineRows } = await client.query(
        `select coalesce(sum(case when to_account = '1220' then fine_weight else 0 end) - sum(case when from_account = '1220' then fine_weight else 0 end), 0) as fine
           from gold_ledger_entries where branch_id = $1 and (to_account = '1220' or from_account = '1220')`, [req.auth.branchId]);
      const bookAmt = Number(bookRows[0].amount) || 0, bookFine = Number(fineRows[0].fine) || 0;
      const price24 = Number(body.price24) || 0;
      const perFine = bookAmt > 0 && bookFine > 0.0005 ? bookAmt / bookFine : price24;
      for (const l of goldLines) l.value = roundMoney(Math.abs(fineWeight(Math.abs(l.variance), l.karat)) * perFine);
      const varianceValue = roundMoney(Math.abs(varianceCash) + Math.abs(varianceNetwork) + goldLines.reduce((a, l) => a + (l.value || 0), 0));

      // ⚖ فرقٌ فوق حدّ «فرق جرد الخزنة» (500 افتراضًا) يمرّ ببوّابة الاعتماد
      const gate = await approvalGate(client, req.auth, {
        kind: "safe_audit", amount: varianceValue, approvalId: body.approvalId || null,
        note: `فرق جرد الخزنة ${audit.ref}`, payload: { ...body, approvalId: undefined },
      });
      if (gate.error) return gate;
      if (gate.pending) return { error: "approval_pending", request: { kind: "safe_audit", amount: varianceValue, note: `فرق جرد الخزنة`, payload: { ...body, approvalId: undefined } } };

      const journalEntryIds = [];

      // ── فرق النقد: سطر cash_tx + قيد يومية بنفس أزواج حسابات
      // cash_surplus/cash_shortage المزروعة أصلًا من chart.js.
      // ⚠ امتداد طبيعي: القاعدة في chart.js تستهدف 1130 (نقدي) دائمًا
      // بلا تمييز طريقة الدفع؛ هنا نستخدم 1140 لفرق الشبكة تحديدًا —
      // نفس منطق فصل الحسابين المطبَّق أصلًا في endpoint البيع.
      for (const [method, variance, cashAccount] of [
        ["cash", varianceCash, "1130"],
        ["network", varianceNetwork, "1140"],
      ]) {
        if (Math.abs(variance) < 0.01) continue;
        const isSurplus = variance > 0;
        await client.query(
          `insert into cash_tx
             (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
           values ($1,$2,'safe',$3,$4,$5,$6,'safe_audits',$7,$8,$9)`,
          [
            req.auth.branchId, businessDayId, method, isSurplus ? "in" : "out", Math.abs(variance),
            isSurplus ? "cash_surplus" : "cash_shortage", audit.id,
            `${isSurplus ? "زيادة" : "عجز"} بجرد الخزنة — ${audit.ref}`, req.auth.userId,
          ]
        );
        const jid = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: isSurplus ? "cash_surplus" : "cash_shortage",
          refTable: "safe_audits",
          refId: audit.id,
          description: `${isSurplus ? "زيادة" : "عجز"} بجرد الخزنة (${method}) — ${audit.ref}`,
          createdBy: req.auth.userId,
          lines: isSurplus
            ? [{ account: cashAccount, side: "debit", amount: Math.abs(variance) }, { account: "4330", side: "credit", amount: Math.abs(variance) }]
            : [{ account: "5330", side: "debit", amount: Math.abs(variance) }, { account: cashAccount, side: "credit", amount: Math.abs(variance) }],
        });
        journalEntryIds.push(jid);
      }

      // ── فرق الذهب لكل عيار: سطر safe_gold_tx + رجل وزنية (1220) + قيدٌ ماليّ بقيمته (المرجع ت١):
      //   زيادة: مدين 1220 / دائن 4320 فائض وزن · عجز: مدين 5330 عجز بالجرد / دائن 1220.
      //   كان الفرق يدخل الدفتر الوزني وحده فيختلف رصيد 1220 بالجرام عن رصيده بالريال.
      for (const line of goldLines) {
        if (Math.abs(line.variance) < 0.0005) continue;
        const isSurplus = line.variance > 0;
        const { rows: gtxRows } = await client.query(
          `insert into safe_gold_tx
             (branch_id, business_day_id, direction, karat, weight, kind, destination, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,$5,'raw',$6,'safe_audits',$7,$8,$9)
           returning id`,
          [
            req.auth.branchId, businessDayId, isSurplus ? "in" : "out", line.karat, Math.abs(line.variance),
            isSurplus ? null : "audit", audit.id, `تسوية جرد الخزنة — عيار ${line.karat} — ${audit.ref}`, req.auth.userId,
          ]
        );
        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,$5,$6, $7,$8, 'safe_gold_tx',$9,$10,$11)`,
          [
            req.auth.branchId, businessDayId, isSurplus ? "safe_gold_in" : "safe_gold_out",
            line.karat, Math.abs(line.variance), fineWeight(Math.abs(line.variance), line.karat),
            isSurplus ? null : "1220", isSurplus ? "1220" : null,
            gtxRows[0].id, `تسوية جرد الخزنة — عيار ${line.karat} — ${audit.ref}`, req.auth.userId,
          ]
        );
        if (line.value > 0) {
          journalEntryIds.push(await postJournalEntry(client, {
            branchId: req.auth.branchId, businessDayId,
            opType: isSurplus ? "safe_gold_in" : "safe_gold_out",
            refTable: "safe_audits", refId: audit.id,
            description: `${isSurplus ? "زيادة" : "عجز"} ذهب بجرد الخزنة — عيار ${line.karat} — ${audit.ref}`,
            createdBy: req.auth.userId,
            lines: isSurplus
              ? [{ account: "1220", side: "debit", amount: line.value }, { account: "4320", side: "credit", amount: line.value }]
              : [{ account: "5330", side: "debit", amount: line.value }, { account: "1220", side: "credit", amount: line.value }],
          }));
        }
      }

      return {
        audit: {
          id: audit.id, ref: audit.ref,
          varianceCash, varianceNetwork, goldLines, varianceValue,
          // فرق ذهبٍ بلا تكلفةٍ ولا سعر: دخل الدفتر الوزني وحده — يُقال لا يُخفى
          unvalued: goldLines.some((l) => Math.abs(l.variance) > 0.0005 && !(l.value > 0)),
        },
        journalEntryIds,
        approvalId: gate.approvalId || null,
      };
    });
    if (result.error === "approval_pending") return recordPendingApproval(res, req.auth, result.request);
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
