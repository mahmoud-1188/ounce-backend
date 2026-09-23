import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, PURITY } from "../domain/weight.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";

const router = Router();

/**
 * POST /api/stocktake/apply — اعتماد الجرد: المخزون يطابق الرفّ، والفرق
 * يمرّ بالدفترين (كان يُعدَّل محليًا فقط فيضيع عند التحميل ولا يصل الدفتر).
 *
 * body: { entries: [{ itemId, countedQty, countedWeight }], price24 }
 *
 * ⚖ قاعدة السعر: الفرق يُقيَّم بتكلفة الشراء (وزن × تكلفة جرام الصنف
 *   بعياره). سعر اليوم بديلٌ **مُعلَن** لصنفٍ بلا تكلفة — يُذكر عدده في
 *   بيان القيد.
 *   عجز:  مدين 5330 عجز بالجرد / دائن 1210 · وزنًا من 1210
 *   زيادة: مدين 1210 / دائن 4320 فائض وزن · وزنًا إلى 1210
 *   القطعة الناقصة تُخرج (issued) لا تُعلَّم مباعة — لا بيع بلا فاتورة.
 */
router.post("/stocktake/apply", authenticate, requirePage("stocktake"), async (req, res, next) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
  const price24 = Number(req.body?.price24) || 0;
  if (!entries.length) return res.status(400).json({ error: "no_entries" });
  for (const e of entries) {
    if (!e.itemId || !(Number(e.countedQty) >= 0) || !Number.isInteger(Number(e.countedQty))) {
      return res.status(400).json({ error: "invalid_entry", entry: e });
    }
  }
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const businessDayId = day?.id || null;
      const stamp = Date.now().toString(36).toUpperCase();
      const missing = new Map(); // karat -> weight
      const surplus = new Map();
      let missingValue = 0, surplusValue = 0, pricedAtMarket = 0;
      const changed = [];

      for (const e of entries) {
        const { rows: itRows } = await client.query(
          "select * from items where id = $1 and branch_id = $2 for update",
          [e.itemId, req.auth.branchId]
        );
        const it = itRows[0];
        if (!it) return { error: "item_not_found", itemId: e.itemId };
        const { rows: freeRows } = await client.query(
          "select id from item_units where item_id = $1 and sold = false and issued = false order by code desc",
          [it.id]
        );
        const counted = Number(e.countedQty);
        const diff = counted - freeRows.length;
        const unitW = Number(it.weight) || 0;
        const countedWeight = e.countedWeight != null && Number(e.countedWeight) > 0 ? Number(e.countedWeight) : unitW;

        if (diff < 0) {
          const ids = freeRows.slice(0, -diff).map((r) => r.id);
          await client.query(
            "update item_units set issued = true, issued_at = now(), issued_by = $2 where id = any($1::uuid[])",
            [ids, req.auth.userId]
          );
        } else if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            await client.query("insert into item_units (item_id, code) values ($1, $2)", [it.id, `${it.ref}-J${stamp}${i + 1}`]);
          }
        }
        if (Math.abs(countedWeight - unitW) > 0.0005) {
          await client.query("update items set weight = $1 where id = $2", [countedWeight, it.id]);
        }
        if (!diff) { if (Math.abs(countedWeight - unitW) > 0.0005) changed.push({ itemId: it.id, diff: 0, weight: countedWeight }); continue; }

        const w = Math.abs(diff) * unitW;
        const bucket = diff < 0 ? missing : surplus;
        bucket.set(it.karat, (bucket.get(it.karat) || 0) + w);
        const cpg = Number(it.cost_per_gram) || 0;
        if (!(cpg > 0)) pricedAtMarket += 1;
        const v = cpg > 0
          ? roundMoney(w * cpg)
          : roundMoney(w * (PURITY[it.karat] || Number(it.karat) / 24) * price24);
        if (diff < 0) missingValue += v; else surplusValue += v;
        changed.push({ itemId: it.id, diff, weight: countedWeight });
      }

      const dateLabel = new Date().toLocaleDateString("en-GB");
      const market = pricedAtMarket ? ` — ${pricedAtMarket} صنف بسعر اليوم لغياب تكلفته` : "";
      const post = async (opType, byKarat, value, lines, label) => {
        for (const [karat, weight] of byKarat) {
          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,$3,$4,$5,$6, $7,$8, 'stocktake',null,$9,$10)`,
            [req.auth.branchId, businessDayId, opType, karat, weight, fineWeight(weight, karat),
              opType === "audit_missing" ? "1210" : null, opType === "audit_missing" ? null : "1210",
              `${label} ${dateLabel}`, req.auth.userId]
          );
        }
        if (value > 0) {
          return postJournalEntry(client, {
            branchId: req.auth.branchId, businessDayId, opType, refTable: "stocktake", refId: null,
            description: `${label} ${dateLabel}${market}`, createdBy: req.auth.userId, lines,
          });
        }
        return null;
      };
      missingValue = roundMoney(missingValue);
      surplusValue = roundMoney(surplusValue);
      const missingJournalId = missing.size ? await post("audit_missing", missing, missingValue, [
        { account: "5330", side: "debit", amount: missingValue },
        { account: "1210", side: "credit", amount: missingValue },
      ], "عجز جرد") : null;
      const surplusJournalId = surplus.size ? await post("weight_surplus", surplus, surplusValue, [
        { account: "1210", side: "debit", amount: surplusValue },
        { account: "4320", side: "credit", amount: surplusValue },
      ], "زيادة جرد") : null;

      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'stocktake',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ entries: entries.length, changed: changed.length, missingValue, surplusValue, pricedAtMarket })]
      );
      return { changed, missingValue, surplusValue, pricedAtMarket, missingJournalId, surplusJournalId };
    });
    if (result.error) return res.status(result.error === "item_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
