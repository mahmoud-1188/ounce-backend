import { Router } from "express";
import { withBranch } from "../db.js";
import {
  authenticate,
  requirePage,
  requireNotDenied,
  requireCanBreak,
  requireCanManageDay,
} from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

/**
 * ⚠ إصلاح عطل حقيقي: كانت convert-to-item (أدناه) تستدعي openDay(client,
 * branchId) بلا أي تعريف أو استيراد لها في هذا الملف إطلاقًا — كل
 * استدعاء لـPOST /scrap/:id/convert-to-item كان يفشل بـReferenceError
 * (500) قبل إدراج أي شيء، أي أن تحويل الكسر لصنفٍ حقيقي كان معطوبًا
 * بالكامل في الإنتاج. الدالة هنا مطابقة حرفيًا للنسخة المكرَّرة في كل
 * ملفات routes الأخرى (misc.routes.js، expenses.routes.js، إلخ) —
 * تعيد معرّف يوم العمل المفتوح الحالي، أو null إن لم يوجد.
 */
async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

const KARATS = [24, 22, 21, 18, 14];

/**
 * دورة الكسر الكاملة — مبنية على: AddScrapModal.jsx (الشراء)،
 * handleReceiveScrapOfficer/handleBreakStones (مسار مسؤول الكسر السريع)،
 * وhandleSendScrap/handleAssessScrap/handleApproveScrap/handleReceiveScrap
 * (مسار المراجعة الإدارية) في GoldInventoryApp.jsx.
 *
 * ثغرة حقيقية اكتُشفت ونُوقِشت معك أثناء البناء: في المرجع، زر "استلام"
 * لطلب محدد (handleReceiveScrap) ينقل القطع من "معتمَد" إلى "في الخزنة"
 * بأوزان مؤكَّدة، لكنه لا يُرحّل أي شيء فعليًا لدفتر خزنة الكسر
 * (safeGoldTx/حساب 1225) — فقط زر منفصل ("إيداع الخزنة" المُجمَّع،
 * handleDepositScrapToVault) يفعل ذلك، وشرطه أن تكون القطعة "معتمَد"
 * بالضبط لا "في الخزنة". يعني لو استُخدم زر "استلام" المحدد بدل
 * "الإيداع" المُجمَّع، تصير القطعة "في الخزنة" بالاسم فقط دون أثر حقيقي
 * في خزنة الكسر. **قرارك**: الإيداع جزء من الاستلام ذاته — فـ"استلام
 * الطلب" هنا (POST /:reqId/receive) يُرحّل لدفتر خزنة الكسر مباشرة، بحيث
 * "in_safe" يعني دائمًا أنها فعليًا داخل الدفتر.
 *
 * أيضًا: op_type المستخدَم في المرجع لفرق وزن التكسير (handleBreakStones)
 * هو "wastage"/"surplus" — "wastage" موجود في posting_rules لكن حسابه
 * "1210" (هالك تصنيع، لا كسر)، و"surplus" غير موجود إطلاقًا في
 * posting_rules فيسقط صامتًا بلا أي قيد. هنا نستخدم "scrap_break_gain"/
 * "scrap_break_loss" ضد حساب 1230 (الحساب الصحيح لكسر قيد المعالجة)،
 * ونُبقي "scrap_assay_gain"/"scrap_assay_loss" الموجودين أصلًا وصحيحين
 * لفرق التقييم الإداري (نفس حساب 1230 أيضًا).
 *
 * ⚠ إصلاح إضافي: كل فروقات الوزن هنا (break_variance، assessedFine،
 * confirmedFine، stonesMarginEst) تمر عبر roundWeight (تقريب لـ3 خانات،
 * مطابق فعليًا لدقة أعمدة numeric(12,3))، لا roundMoney (تقريب لخانتين،
 * مصمَّم أصلًا للهللات) — استخدام الأخير هنا كان يُفقِد الخانة الثالثة
 * من دقة الوزن بصمت، اكتُشف أثناء بناء استهلاك FIFO في purchases.routes.js.
 */

router.use(
  "/scrap",
  authenticate,
  (req, res, next) => {
    // كل مسارات الكسر تحت بادئة واحدة؛ صلاحية الصفحة الدقيقة تُفرض
    // لكل route على حدة أدناه (scrapIntake للشراء، scrapCustody
    // للاستلام/التكسير، scrap للمراجعة الإدارية) لأنها تختلف باختلاف
    // الفعل، لا موحّدة كسائر endpoints هذا المشروع.
    next();
  }
);

// ── ⓪ الشراء من الزبون ──
router.post(
  "/scrap",
  requirePage("scrapIntake"),
  requireNotDenied("buyScrap"),
  async (req, res, next) => {
    const body = req.body || {};
    const karat = Number(body.karat);
    const weight = Number(body.weight);
    const pricePerGram = Number(body.pricePerGram);
    const grossWeight = body.grossWeight != null ? Number(body.grossWeight) : null;
    const paymentMethod = body.paymentMethod === "network" ? "network" : "cash";

    if (!KARATS.includes(karat)) {
      // ⚠ الفرونت إند يدعم "غير محدد" كخيار عيار عند الشراء، لكن بلا عيار
      // رقمي لا يمكن ترحيل دفتر الوزن (يحتاج fine-grams لكل عيار). قرار
      // تضييق نطاق متعمَّد: هذا الـendpoint يتطلب عيارًا رقميًا معروفًا
      // وقت الشراء؛ حالة "غير محدد" تحتاج تمديدًا لاحقًا (ترحيل الوزن
      // مؤجَّل لمرحلة التقييم) — موثَّق في الـREADME.
      return res.status(400).json({ error: "karat_required" });
    }
    if (!(weight > 0) || !(pricePerGram >= 0)) {
      return res.status(400).json({ error: "invalid_weight_or_price" });
    }

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: lockRows } = await client.query(
          "select locked from stocktake_locks where branch_id = $1",
          [req.auth.branchId]
        );
        if (lockRows[0]?.locked) return { error: "stocktake_locked" };

        const { rows: dayRows } = await client.query(
          `select id from business_days where branch_id = $1 and status = 'open'
            order by opened_at desc limit 1`,
          [req.auth.branchId]
        );
        const businessDayId = dayRows[0]?.id || null;

        const manual = Number(body.totalOverride);
        const total =
          Number.isFinite(manual) && manual > 0
            ? roundMoney(manual)
            : roundMoney(weight * pricePerGram);
        // ⚠ سعر الجرام الفعّال يُشتق من المبلغ المعتمد لا المُدخَل خامًا —
        // نفس منطق handleAddScrap (المبلغ اليدوي هو المعتمد).
        const effectivePricePerGram = weight > 0 ? Math.round((total / weight) * 10000) / 10000 : pricePerGram;

        const { rows: balRows } = await client.query(
          `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
             from scrap_custody where branch_id = $1`,
          [req.auth.branchId]
        );
        const custodyBalance = Number(balRows[0]?.balance) || 0;
        if (total > custodyBalance + 0.01) {
          return { error: "insufficient_scrap_custody_balance", available: custodyBalance, requested: total };
        }

        const stonesMarginEst = grossWeight != null ? Math.max(0, roundWeight(grossWeight - weight)) : 0;
        const stage = stonesMarginEst > 0.0005 ? "pending_break" : "in_box";

        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from scrap_items where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `SCR-${String(refRows[0].n).padStart(6, "0")}`;

        const { rows: itemRows } = await client.query(
          `insert into scrap_items
             (branch_id, ref, karat_est, weight_est, stage, business_day_id, created_by,
              customer_name, description, gross_weight, stones_margin_est, price_per_gram,
              total_paid, payment_method)
           values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12, $13,$14)
           returning id, ref`,
          [
            req.auth.branchId, ref, karat, weight, stage, businessDayId, req.auth.userId,
            body.customerName || null, body.description || null, grossWeight, stonesMarginEst,
            effectivePricePerGram, total, paymentMethod,
          ]
        );
        const item = itemRows[0];

        await client.query(
          `insert into scrap_custody (branch_id, business_day_id, direction, amount, note, created_by)
           values ($1,$2,'out',$3,$4,$5)`,
          [req.auth.branchId, businessDayId, total, `شراء كسر ${item.ref}${body.description ? " - " + body.description : ""}`, req.auth.userId]
        );

        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'scrap_buy',$3,$4,$5, null,'1230', 'scrap_items',$6,$7,$8)`,
          [req.auth.branchId, businessDayId, karat, weight, fineWeight(weight, karat), item.id, `شراء كسر ${item.ref}`, req.auth.userId]
        );

        const journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId,
          businessDayId,
          opType: "scrap_buy",
          refTable: "scrap_items",
          refId: item.id,
          description: `شراء كسر ${item.ref}`,
          createdBy: req.auth.userId,
          lines: [
            { account: "5120", side: "debit", amount: total },
            { account: "1150", side: "credit", amount: total },
          ],
        });

        await client.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
           values ($1,'create',$2,'scrap_items',$3,$4)`,
          [req.auth.branchId, req.auth.userId, item.id, JSON.stringify({ ref: item.ref, total, karat, weight, stage })]
        );

        return { scrapItem: { id: item.id, ref: item.ref, karat, weight, total, stage }, journalEntryId };
      });

      if (result.error) return res.status(409).json(result);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ① مسؤول الكسر يستلم من الصندوق ──
router.post(
  "/scrap/:id/receive-by-officer",
  requirePage("scrapCustody"),
  async (req, res, next) => {
    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows } = await client.query(
          "select id, stage from scrap_items where id = $1 and branch_id = $2 for update",
          [req.params.id, req.auth.branchId]
        );
        const item = rows[0];
        if (!item) return { error: "scrap_item_not_found" };
        if (item.stage !== "in_box") {
          return { error: "scrap_item_not_in_box", stage: item.stage };
        }
        await client.query(
          `update scrap_items set stage = 'received', received_by = $1, received_at = now() where id = $2`,
          [req.auth.userId, item.id]
        );
        return { ok: true };
      });
      if (result.error) {
        const status = result.error === "scrap_item_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ②a مسار مسؤول الكسر السريع: تكسير الفصوص وتثبيت الوزن → الخزنة مباشرة ──
router.post(
  "/scrap/:id/break-stones",
  requirePage("scrapCustody"),
  requireCanBreak,
  requireNotDenied("breakStones"),
  async (req, res, next) => {
    const actualNetWeight = Number(req.body?.actualNetWeight);
    if (!(actualNetWeight > 0)) {
      return res.status(400).json({ error: "actual_net_weight_required" });
    }
    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows } = await client.query(
          "select * from scrap_items where id = $1 and branch_id = $2 for update",
          [req.params.id, req.auth.branchId]
        );
        const item = rows[0];
        if (!item) return { error: "scrap_item_not_found" };
        if (!["pending_break", "received"].includes(item.stage)) {
          return { error: "scrap_item_not_breakable", stage: item.stage };
        }
        const gross = Number(item.gross_weight) || Number(item.weight_est) || 0;
        if (actualNetWeight > gross * 1.1 + 0.0005) {
          return { error: "net_weight_exceeds_gross", gross, requested: actualNetWeight };
        }

        const paidOn = Number(item.weight_est) || 0;
        const variance = roundWeight(actualNetWeight - paidOn);
        const karat = item.karat_est;

        await client.query(
          `update scrap_items set
             weight_final = $1, karat_final = $2, actual_stones_weight = $3,
             break_variance = $4, refined = true, stage = 'in_safe',
             weight_remaining = $1, broken_by = $5, broken_at = now()
           where id = $6`,
          [actualNetWeight, karat, roundWeight(gross - actualNetWeight), variance, req.auth.userId, item.id]
        );

        let varianceJournalEntryId = null;
        if (Math.abs(variance) > 0.0005) {
          await client.query(
            `insert into scrap_surplus (branch_id, scrap_item_id, weight_diff, note, created_by)
             values ($1,$2,$3,$4,$5)`,
            [req.auth.branchId, item.id, variance, `فرق تكسير ${item.ref}`, req.auth.userId]
          );
          const gain = variance > 0;
          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,$3,$4,$5,$6, $7,$8, 'scrap_items',$9,$10,$11)`,
            [
              req.auth.branchId, item.business_day_id, gain ? "scrap_break_gain" : "scrap_break_loss",
              karat, Math.abs(variance), fineWeight(Math.abs(variance), karat),
              gain ? null : "1230", gain ? "1230" : null, item.id, `فرق تكسير ${item.ref}`, req.auth.userId,
            ]
          );
        }

        // ⚠ نفس التصحيح المطبَّق في مسار المراجعة الإدارية: التكسير
        // يُرحّل مباشرة لدفتر خزنة الكسر (1225) لأنه ينهي دورة القطعة
        // بنفس لحظة إثبات وزنها — لا خطوة "إيداع" منفصلة تنتظر.
        await client.query(
          `insert into safe_gold_tx
             (branch_id, business_day_id, direction, karat, weight, destination, supplier_id, note, created_by)
           values ($1,$2,'in',$3,$4,'scrap_break',null,$5,$6)`,
          [req.auth.branchId, item.business_day_id, karat, actualNetWeight, `تكسير ${item.ref}`, req.auth.userId]
        );

        return {
          scrapItem: { id: item.id, ref: item.ref, weightFinal: actualNetWeight, variance, stage: "in_safe" },
          varianceJournalEntryId,
        };
      });
      if (result.error) {
        const status = result.error === "scrap_item_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ②b مسار المراجعة الإدارية: إرسال دفعة للفحص ──
router.post(
  "/scrap/send",
  requirePage("scrap"),
  requireNotDenied("sendScrap"),
  async (req, res, next) => {
    const scrapItemIds = Array.isArray(req.body?.scrapItemIds) ? req.body.scrapItemIds : [];
    if (!scrapItemIds.length) return res.status(400).json({ error: "no_items_selected" });

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: items } = await client.query(
          `select * from scrap_items where id = any($1::uuid[]) and branch_id = $2 and stage = 'in_box' for update`,
          [scrapItemIds, req.auth.branchId]
        );
        if (!items.length) return { error: "no_eligible_items" };

        const sentLines = items.map((it) => ({
          scrapItemId: it.id, ref: it.ref, karat: it.karat_est,
          weight: Number(it.weight_est) || 0, stonesMargin: Number(it.stones_margin_est) || 0,
          pricePerGram: Number(it.price_per_gram) || 0,
        }));
        const sentFine = sentLines.reduce((a, l) => a + fineWeight(l.weight, l.karat), 0);

        const { rows: dayRows } = await client.query(
          `select id from business_days where branch_id = $1 and status = 'open'
            order by opened_at desc limit 1`,
          [req.auth.branchId]
        );
        const businessDayId = dayRows[0]?.id || null;

        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from scrap_requests where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `SCRQ-${String(refRows[0].n).padStart(6, "0")}`;

        const { rows: reqRows } = await client.query(
          `insert into scrap_requests
             (branch_id, ref, status, payload, business_day_id, sent_fine, note, created_by)
           values ($1,$2,'pending',$3,$4,$5,$6,$7)
           returning id, ref`,
          [
            req.auth.branchId, ref, JSON.stringify({ sentLines }), businessDayId, sentFine,
            req.body.note || null, req.auth.userId,
          ]
        );
        const request = reqRows[0];

        await client.query(
          `update scrap_items set stage = 'sent', request_id = $1, sent_by = $2, sent_at = now()
           where id = any($3::uuid[])`,
          [request.id, req.auth.userId, items.map((it) => it.id)]
        );

        return { request: { id: request.id, ref: request.ref, itemCount: items.length, sentFine } };
      });
      if (result.error) return res.status(409).json(result);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ③ الإدارة تفحص وتثبّت الوزن الصافي ──
router.post(
  "/scrap/:reqId/assess",
  requirePage("scrap"),
  requireNotDenied("assessScrap"),
  async (req, res, next) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) return res.status(400).json({ error: "no_lines" });

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: reqRows } = await client.query(
          "select * from scrap_requests where id = $1 and branch_id = $2 for update",
          [req.params.reqId, req.auth.branchId]
        );
        const request = reqRows[0];
        if (!request) return { error: "request_not_found" };
        if (request.status !== "pending") return { error: "request_not_pending", status: request.status };

        const sentLines = request.payload?.sentLines || [];
        const clean = lines.map((l) => {
          const sent = sentLines.find((s) => s.scrapItemId === l.scrapItemId);
          const karat = Number(l.karat) || sent?.karat || 21;
          return {
            scrapItemId: l.scrapItemId, karat,
            netWeight: Number(l.netWeight) || 0,
            stonesRemoved: Number(l.stonesRemoved) || 0,
          };
        });
        const assessedFine = clean.reduce((a, l) => a + fineWeight(l.netWeight, l.karat), 0);
        const sentFine = Number(request.sent_fine) || 0;
        const variance = roundWeight(assessedFine - sentFine);

        await client.query(
          `update scrap_requests set
             status = 'assessed', assessed_by = $1, assessed_at = now(),
             assessed_fine = $2, variance = $3, assess_note = $4,
             payload = payload || $5::jsonb
           where id = $6`,
          [
            req.auth.userId, assessedFine, variance, req.body.note || null,
            JSON.stringify({ assessedLines: clean }), request.id,
          ]
        );
        await client.query(
          `update scrap_items set stage = 'assessed' where request_id = $1`,
          [request.id]
        );

        return { request: { id: request.id, ref: request.ref, assessedFine, variance } };
      });
      if (result.error) {
        const status = result.error === "request_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ④ الاعتماد ──
router.post(
  "/scrap/:reqId/approve",
  requirePage("scrap"),
  requireNotDenied("approveScrap"),
  async (req, res, next) => {
    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows } = await client.query(
          "select * from scrap_requests where id = $1 and branch_id = $2 for update",
          [req.params.reqId, req.auth.branchId]
        );
        const request = rows[0];
        if (!request) return { error: "request_not_found" };
        if (request.status !== "assessed") return { error: "request_not_assessed", status: request.status };

        await client.query(
          `update scrap_requests set status = 'approved', approved_by = $1, approved_at = now() where id = $2`,
          [req.auth.userId, request.id]
        );
        await client.query(`update scrap_items set stage = 'approved' where request_id = $1`, [request.id]);

        return { request: { id: request.id, ref: request.ref, status: "approved" } };
      });
      if (result.error) {
        const status = result.error === "request_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── ⑤ الفرع يستلم بالوزن المؤكَّد بعد التكسير الفعلي ويدخله دفتر الخزنة ──
router.post(
  "/scrap/:reqId/receive",
  requirePage("scrap"),
  async (req, res, next) => {
    const confirmed = Array.isArray(req.body?.confirmed) ? req.body.confirmed : [];

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows } = await client.query(
          "select * from scrap_requests where id = $1 and branch_id = $2 for update",
          [req.params.reqId, req.auth.branchId]
        );
        const request = rows[0];
        if (!request) return { error: "request_not_found" };
        if (request.status !== "approved") return { error: "request_not_approved", status: request.status };

        const assessedLines = request.payload?.assessedLines || [];
        const conf = {};
        confirmed.forEach((c) => {
          const w = Number(c.weight);
          if (Number.isFinite(w) && w > 0) conf[c.scrapItemId] = w;
        });
        const missing = assessedLines.filter((l) => conf[l.scrapItemId] == null);
        if (missing.length) {
          return { error: "unconfirmed_lines", missing: missing.map((l) => l.scrapItemId) };
        }

        const byKarat = new Map();
        let confirmedFine = 0;
        for (const l of assessedLines) {
          const w = conf[l.scrapItemId];
          confirmedFine += fineWeight(w, l.karat);
          byKarat.set(l.karat, (byKarat.get(l.karat) || 0) + w);
          await client.query(
            `update scrap_items set
               karat_final = $1, weight_final = $2, weight_remaining = $2,
               stage = 'in_safe', confirmed_by = $3, confirmed_at = now()
             where id = $4`,
            [l.karat, w, req.auth.userId, l.scrapItemId]
          );
        }

        const sentFine = Number(request.sent_fine) || 0;
        const variance = roundWeight(confirmedFine - sentFine);
        let varianceJournalEntryId = null;
        if (Math.abs(variance) > 0.0005) {
          const gain = variance > 0;
          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,$3,24,$4,$4, $5,$6, 'scrap_requests',$7,$8,$9)`,
            [
              req.auth.branchId, request.business_day_id, gain ? "scrap_assay_gain" : "scrap_assay_loss",
              Math.abs(variance), gain ? null : "1230", gain ? "1230" : null, request.id,
              `تقييم ${request.ref}`, req.auth.userId,
            ]
          );
        }

        // ⚠ التصحيح المذكور أعلى الملف: الاستلام يُرحّل لدفتر خزنة الكسر
        // مباشرة (سطر لكل عيار)، فلا تبقى "in_safe" اسمًا بلا أثر.
        for (const [karat, weight] of byKarat) {
          await client.query(
            `insert into safe_gold_tx
               (branch_id, business_day_id, direction, karat, weight, destination, supplier_id, note, created_by)
             values ($1,$2,'in',$3,$4,'scrap_receive',null,$5,$6)`,
            [req.auth.branchId, request.business_day_id, karat, weight, `استلام ${request.ref}`, req.auth.userId]
          );
        }

        await client.query(
          `update scrap_requests set
             status = 'received', received_by = $1, received_at = now(),
             confirmed_fine = $2, variance = $3, payload = payload || $4::jsonb
           where id = $5`,
          [
            req.auth.userId, confirmedFine, variance,
            JSON.stringify({ confirmedLines: assessedLines.map((l) => ({ ...l, confirmed: conf[l.scrapItemId] })) }),
            request.id,
          ]
        );

        return { request: { id: request.id, ref: request.ref, confirmedFine, variance }, varianceJournalEntryId };
      });
      if (result.error) {
        const status = result.error === "request_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── إيداع احتياطي مُجمَّع (نادرًا ما يُحتاج بعد تصحيح ⑤ أعلاه) ──
//
// ⚠ يستخدم weight_est (الوزن وقت الشراء) لا أي وزن مُقيَّم/مؤكَّد، لأن
// تلك القيم لا تعيش إلا داخل payload الخاص بطلب تقييم بعينه — تجميعها عبر
// طلبات متعددة في استعلام دفعي واحد يُعقّد أداة احتياطية نادرة الاستخدام
// بلا مبرر يوازي ذلك. مطابق تمامًا لثغرة موجودة أصلًا في المرجع نفسه
// (handleDepositScrapToVault يقرأ e.weight الذي لم يُحدَّث بالتقييم إن لم
// يمرّ عبر "استلام" الطلب أولًا) — موثَّق كتحفّظ صريح لا إصلاح صامت.
router.post(
  "/scrap/deposit-to-vault",
  requireCanManageDay,
  async (req, res, next) => {
    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: items } = await client.query(
          `select * from scrap_items where branch_id = $1 and stage = 'approved' for update`,
          [req.auth.branchId]
        );
        if (!items.length) return { deposited: [], count: 0 };

        const byKarat = new Map();
        for (const it of items) {
          const karat = it.karat_est;
          const weight = Number(it.weight_est) || 0;
          byKarat.set(karat, (byKarat.get(karat) || 0) + weight);
          await client.query(
            `update scrap_items set
               karat_final = $1, weight_final = $2, weight_remaining = $2,
               stage = 'in_safe', confirmed_by = $3, confirmed_at = now()
             where id = $4`,
            [karat, weight, req.auth.userId, it.id]
          );
        }
        for (const [karat, weight] of byKarat) {
          await client.query(
            `insert into safe_gold_tx
               (branch_id, business_day_id, direction, karat, weight, destination, supplier_id, note, created_by)
             values ($1,null,'in',$2,$3,'scrap_deposit',null,$4,$5)`,
            [req.auth.branchId, karat, weight, `إيداع كسر اليوم — ${items.length} قطعة`, req.auth.userId]
          );
        }
        return { deposited: [...byKarat.entries()].map(([karat, weight]) => ({ karat, weight })), count: items.length };
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── تحويل قطعة كسر مُصفَّاة لمخزون قابل للبيع — handleConvertScrap ──
//
// ⚠ لم يوجد أي مسار لكتابة items إطلاقًا قبل هذا (لا هنا ولا في
// purchases.routes.js) — الفرونت إند كان يبني القطعة محليًا فقط ويخزّنها
// في window.storage، فتختفي بعد إعادة تحميل الصفحة تمامًا كسجل الكسر نفسه.
//
// الشرط: القطعة يجب أن تكون "in_safe" فعليًا (وزنها مثبَّت من تكسير أو
// استلام طلب مُعتمد) — لا تُدخَل قطعة "قيد الانتظار" لمخزون البيع بوزن
// غير مؤكَّد. ووزنها لا يزال "في الخزنة" منطقيًا (دفتر خزنة الكسر 1230)؛
// تحويلها لمخزون مشغول جاهز للبيع (1210) هو بالضبط ما يُعيد تصنيف الوزن.
router.post(
  "/scrap/:id/convert-to-item",
  requireCanManageDay,
  requireNotDenied("convertScrap"),
  async (req, res, next) => {
    const body = req.body || {};
    const categoryId = body.categoryId || null;

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows } = await client.query(
          "select * from scrap_items where id = $1 and branch_id = $2 for update",
          [req.params.id, req.auth.branchId]
        );
        const item = rows[0];
        if (!item) return { error: "scrap_item_not_found" };
        if (item.stage !== "in_safe") {
          return { error: "scrap_item_not_ready", stage: item.stage };
        }
        if (item.consumed_at) return { error: "scrap_item_already_converted" };

        const karat = item.karat_final || item.karat_est;
        const weight = roundWeight(Number(item.weight_remaining ?? item.weight_final ?? item.weight_est) || 0);
        if (!(weight > 0)) return { error: "zero_weight" };

        // ⚠ تصنيف صريح مطلوب: بلا category_id (NOT NULL FK) لا يمكن
        // الإدراج — إن لم يُرسله الفرونت إند نأخذ أول تصنيف متاح للفرع
        // (مشترك أو خاص به) بدل رفض العملية بلا داعٍ.
        let finalCategoryId = categoryId;
        if (finalCategoryId) {
          const { rows: catRows } = await client.query(
            "select id from categories where id = $1 and (branch_id = $2 or branch_id is null)",
            [finalCategoryId, req.auth.branchId]
          );
          if (!catRows[0]) return { error: "category_not_found" };
        } else {
          const { rows: catRows } = await client.query(
            "select id from categories where branch_id = $1 or branch_id is null order by branch_id nulls last limit 1",
            [req.auth.branchId]
          );
          if (!catRows[0]) return { error: "no_category_available" };
          finalCategoryId = catRows[0].id;
        }

        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from items where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `ITM-${String(refRows[0].n).padStart(6, "0")}`;

        const businessDayId = await openDay(client, req.auth.branchId);

        const { rows: itemRows } = await client.query(
          `insert into items
             (branch_id, ref, category_id, karat, weight, stones_weight, cost_per_gram,
              workmanship, lot_workmanship_share, from_scrap, business_day_id, created_by)
           values ($1,$2,$3,$4,$5,0,$6, 0,0,true,$7,$8)
           returning id, ref, karat, weight, date_added`,
          [
            req.auth.branchId, ref, finalCategoryId, karat, weight,
            item.price_per_gram || null, businessDayId, req.auth.userId,
          ]
        );
        const newItem = itemRows[0];

        const { rows: unitRows } = await client.query(
          `insert into item_units (item_id, code) values ($1,$2) returning id, code`,
          [newItem.id, ref]
        );

        await client.query(
          `update scrap_items set stage = 'used', weight_remaining = 0,
             consumed_at = now(), consumed_by = $1, converted_item_id = $2
           where id = $3`,
          [req.auth.userId, newItem.id, item.id]
        );

        // ⚠ إعادة تصنيف وزن فقط (1230 → 1210) — لا قيد مالي: القيمة
        // دخلت الدفاتر أصلًا وقت شراء الكسر (scrap_buy)، فلا تكلفة جديدة
        // هنا، تمامًا كمنطق safe_gold_in/out بلا حساب نقدي مقابل.
        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'scrap_convert',$3,$4,$5, '1230','1210', 'items',$6,$7,$8)`,
          [
            req.auth.branchId, businessDayId, karat, weight, fineWeight(weight, karat),
            newItem.id, `تحويل كسر ${item.ref} لمخزون`, req.auth.userId,
          ]
        );

        return {
          item: {
            id: newItem.id, ref: newItem.ref, categoryId: finalCategoryId,
            karat: newItem.karat, weight: Number(newItem.weight),
            dateAdded: newItem.date_added, fromScrap: true,
            scrapId: item.id, scrapRef: item.ref,
            units: [{ code: unitRows[0].code, printed: false, sold: false }],
          },
        };
      });
      if (result.error) {
        const status = result.error === "scrap_item_not_found" || result.error === "category_not_found"
          ? 404
          : 409;
        return res.status(status).json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
