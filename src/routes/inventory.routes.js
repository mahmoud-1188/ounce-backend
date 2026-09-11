import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied, requireCanManageDay } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

// من ISSUE_REASONS في core/constants.js — نفس المعرّفات والحسابات حرفيًا.
const ISSUE_REASONS = {
  returned_supplier: { account: "1320", label: "إعادة للمورد" },
  damaged: { account: "5310", label: "تلف" },
  lost: { account: "5310", label: "فقد" },
  gift: { account: "6900", label: "هدية أو عيّنة" },
  melted: { account: "1230", label: "تحويل لكسر" },
  branch: { account: "1350", label: "تحويل لفرع آخر" },
  correction: { account: "5310", label: "تصحيح إدخال خاطئ" },
};

router.use("/inventory", authenticate, requirePage("goldOut"), requireCanManageDay, requireNotDenied("issueOut"));

/**
 * POST /api/inventory/issue-out — إخراج قطع جاهزة من النظام بلا بيع
 * (تلف/فقد/هدية/تحويل لكسر/لفرع آخر/تصحيح) — handleIssueOut.
 *
 * ⚠ إصلاح حقيقي بعد سؤالك الصريح: في المرجع، `postWeight("gold_out", …)`
 * يستدعي مفتاحًا غير موجود إطلاقًا في posting_rules (المفتاح الصحيح
 * "safe_gold_out"، وحتى هو يستهدف 1220 لا 1210) — فالعملية تُعلِّم الوحدة
 * "مُخرَجة" وتُسجّل سطر تدقيق فقط، بلا أي ترحيل فعلي لدفتر الوزن أو
 * ليومية. هنا:
 * 1. دفتر الوزن: سطر لكل عيار، من=1210 إلى=null (كلا الحسابين ضمن
 *    weight_accounts المسموحة فعليًا كـtrigger في قاعدتنا).
 * 2. قيد يومية بالتكلفة: مدين حساب السبب (5310/6900/1320/1230/1350
 *    بحسب reasonId) = دائن 1210 — **لم يوجد إطلاقًا في المرجع** (لا قيد
 *    يومية لإخراج البضاعة هناك)؛ أضيف بقرارك الصريح كي لا تختفي قيمة
 *    القطعة من القوائم المالية دون أثر.
 *    ⚠ حسابات الأسباب نفسها (1320/5310/6900/1350) ليست ضمن
 *    weight_accounts المسموحة في دفتر الوزن — فقيد اليومية المالي هذا هو
 *    الموضع الصحيح الوحيد لها، لا دفتر الوزن.
 */
router.post("/inventory/issue-out", async (req, res, next) => {
  const body = req.body || {};
  const reasonId = body.reasonId;
  const unitIds = Array.isArray(body.unitIds) ? [...new Set(body.unitIds)] : [];
  const note = body.note || null;

  const reason = ISSUE_REASONS[reasonId];
  if (!reason) return res.status(400).json({ error: "invalid_reason" });
  if (!unitIds.length) return res.status(400).json({ error: "no_units_selected" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: unitRows } = await client.query(
        `select u.id, u.code, i.id as item_id, i.karat, i.weight, i.cost_per_gram, i.workmanship
           from item_units u
           join items i on i.id = u.item_id
          where u.id = any($1::uuid[]) and i.branch_id = $2
            and u.sold = false and u.issued = false
          for update of u`,
        [unitIds, req.auth.branchId]
      );
      if (unitRows.length < unitIds.length) {
        const found = new Set(unitRows.map((r) => r.id));
        return { error: "units_unavailable", missing: unitIds.filter((id) => !found.has(id)) };
      }

      const { rows: dayRows } = await client.query(
        `select id from business_days where branch_id = $1 and status = 'open'
          order by opened_at desc limit 1`,
        [req.auth.branchId]
      );
      const businessDayId = dayRows[0]?.id || null;

      const byKarat = new Map();
      let totalWeight = 0;
      let totalFineWeight = 0;
      let totalCost = 0;
      const lines = unitRows.map((u) => {
        const weight = Number(u.weight);
        const cost = roundMoney(weight * Number(u.cost_per_gram || 0) + Number(u.workmanship || 0));
        totalWeight += weight;
        totalFineWeight += fineWeight(weight, u.karat);
        totalCost += cost;
        byKarat.set(u.karat, (byKarat.get(u.karat) || 0) + weight);
        return { itemUnitId: u.id, code: u.code, itemId: u.item_id, karat: u.karat, weight, cost };
      });
      totalCost = roundMoney(totalCost);

      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from gold_issues where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `ISS-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: issueRows } = await client.query(
        `insert into gold_issues
           (branch_id, ref, business_day_id, reason_id, account, lines, total_weight, total_fine_weight, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         returning id, ref`,
        [
          req.auth.branchId, ref, businessDayId, reasonId, reason.account,
          JSON.stringify(lines), totalWeight, totalFineWeight, note, req.auth.userId,
        ]
      );
      const issue = issueRows[0];

      await client.query(
        `update item_units set issued = true, issued_at = now(), issued_by = $1, issue_id = $2
          where id = any($3::uuid[])`,
        [req.auth.userId, issue.id, unitRows.map((u) => u.id)]
      );

      for (const [karat, weight] of byKarat) {
        await client.query(
          `insert into gold_ledger_entries
             (branch_id, business_day_id, op_type, karat, weight, fine_weight,
              from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'gold_issue_out',$3,$4,$5, '1210',null, 'gold_issues',$6,$7,$8)`,
          [req.auth.branchId, businessDayId, karat, weight, fineWeight(weight, karat), issue.id, `إخراج بضاعة (${reason.label}) — ${issue.ref}`, req.auth.userId]
        );
      }

      // لو كانت تكلفة كل الوحدات صفرًا (بيانات ناقصة استثنائيًا) لا نحاول
      // ترحيل قيد يومية بخطين صفريين — postJournalEntry يُصفّي الأسطر
      // الصفرية أصلًا، فقيد بخطين صفريين يصبح فارغًا تمامًا.
      const journalEntryId = totalCost > 0.005
        ? await postJournalEntry(client, {
            branchId: req.auth.branchId,
            businessDayId,
            opType: "gold_issue_out",
            refTable: "gold_issues",
            refId: issue.id,
            description: `إخراج بضاعة (${reason.label}) — ${issue.ref}`,
            createdBy: req.auth.userId,
            lines: [
              { account: reason.account, side: "debit", amount: totalCost },
              { account: "1210", side: "credit", amount: totalCost },
            ],
          })
        : null;

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'delete',$2,'gold_issues',$3,$4)`,
        [req.auth.branchId, req.auth.userId, issue.id, JSON.stringify({ ref: issue.ref, reasonId, unitCount: lines.length, totalCost })]
      );

      return {
        issue: { id: issue.id, ref: issue.ref, reasonId, unitCount: lines.length, totalWeight, totalFineWeight, totalCost },
        journalEntryId,
      };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
