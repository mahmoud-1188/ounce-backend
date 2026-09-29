import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager, requirePage } from "../middleware/auth.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, PURITY } from "../domain/weight.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";
import { closeMonth, fiscalStatus } from "../domain/periodClose.js";

const router = Router();

/// يطبّق الجرد داخل معاملة الفرع — مشتركٌ بين جرد الفرع والجرد المُرسَل من الإدارة (migration 061)
async function applyStocktake(client, { branchId, userId, entries, price24 = 0, extra = null }) {
      const day = await getOpenBusinessDay(client, branchId);
      const businessDayId = day?.id || null;
      const stamp = Date.now().toString(36).toUpperCase();
      const missing = new Map(); // karat -> weight
      const surplus = new Map();
      let missingValue = 0, surplusValue = 0, pricedAtMarket = 0;
      const changed = [];

      for (const e of entries) {
        const { rows: itRows } = await client.query(
          "select * from items where id = $1 and branch_id = $2 for update",
          [e.itemId, branchId]
        );
        const it = itRows[0];
        if (!it) return { error: "item_not_found", itemId: e.itemId };
        const { rows: freeRows } = await client.query(
          "select id, code from item_units where item_id = $1 and sold = false and issued = false order by code desc",
          [it.id]
        );
        const counted = Number(e.countedQty);
        const diff = counted - freeRows.length;
        const unitW = Number(it.weight) || 0;
        const countedWeight = e.countedWeight != null && Number(e.countedWeight) > 0 ? Number(e.countedWeight) : unitW;

        if (diff < 0) {
          // ⚠ العدّ بالمسح يعرف الناقص بعينه (missingCodes): تُخرج تلك الرموز لا أيّ قطعٍ حرّة بعددها —
          //   وإلا خرجت قطعةٌ قُرئت على الرفّ وبقيت الناقصة «متاحة». الباقي (عدٌّ يدوي) بالعدد كما كان.
          const wanted = Array.isArray(e.missingCodes) ? e.missingCodes.map((c) => String(c).toUpperCase()) : [];
          const named = wanted.length
            ? freeRows.filter((r) => wanted.includes(String(r.code).toUpperCase())).slice(0, -diff)
            : [];
          const rest = freeRows.filter((r) => !named.includes(r)).slice(0, -diff - named.length);
          const ids = [...named, ...rest].map((r) => r.id);
          await client.query(
            "update item_units set issued = true, issued_at = now(), issued_by = $2 where id = any($1::uuid[])",
            [ids, userId]
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
            [branchId, businessDayId, opType, karat, weight, fineWeight(weight, karat),
              opType === "audit_missing" ? "1210" : null, opType === "audit_missing" ? null : "1210",
              `${label} ${dateLabel}`, userId]
          );
        }
        if (value > 0) {
          return postJournalEntry(client, {
            branchId: branchId, businessDayId, opType, refTable: "stocktake", refId: null,
            description: `${label} ${dateLabel}${market}`, createdBy: userId, lines,
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
        [branchId, userId, JSON.stringify({ entries: entries.length, changed: changed.length, missingValue, surplusValue, pricedAtMarket, ...(extra || {}) })]
      );
      return { changed, missingValue, surplusValue, pricedAtMarket, missingJournalId, surplusJournalId };
}

/**
 * POST /api/stocktake/apply — اعتماد الجرد: المخزون يطابق الرفّ، والفرق
 * يمرّ بالدفترين (كان يُعدَّل محليًا فقط فيضيع عند التحميل ولا يصل الدفتر).
 *
 * body: { entries: [{ itemId, countedQty, countedWeight, missingCodes? }], price24 }
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
    const result = await withBranch(req.auth.branchId, (client) =>
      applyStocktake(client, { branchId: req.auth.branchId, userId: req.auth.userId, entries, price24 }));
    if (result.error) return res.status(result.error === "item_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * الجرد المُرسَل من الإدارة (migration 061): يصل الفرع طلبًا — مديره يطبّقه بمعالج الجرد نفسه باسمه
 * (والعدّ عدّ الإدارة) أو يرفضه. الوزن من بطاقة الصنف كما في المرجع (HqRemoteStocktake).
 *   GET  /stocktake/remote
 *   POST /stocktake/remote/:id/apply { price24 }
 *   POST /stocktake/remote/:id/reject { note }
 */
router.get("/stocktake/remote", authenticate, requirePage("stocktake"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select r.*, u.name as decided_by_name from remote_stocktakes r left join users u on u.id = r.decided_by
        where r.branch_id = $1 order by (r.status = 'pending') desc, r.requested_at desc limit 30`, [req.auth.branchId])).rows);
    res.json({ stocktakes: rows.map((r) => ({ id: r.id, ref: r.ref, counts: r.counts || [], note: r.note || "", status: r.status,
      requestedBy: r.requested_by, requestedAt: r.requested_at, decidedBy: r.decided_by_name || null, decidedAt: r.decided_at, result: r.result || null })) });
  } catch (err) {
    next(err);
  }
});

router.post("/stocktake/remote/:id/apply", authenticate, requirePage("stocktake"), requireManager, async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from remote_stocktakes where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const r = rows[0];
      if (!r) return { error: "not_found" };
      if (r.status !== "pending") return { error: "already_decided" };
      const entries = (r.counts || []).map((x) => ({ itemId: x.itemId, countedQty: Number(x.countedQty) }));
      const out = await applyStocktake(client, { branchId: req.auth.branchId, userId: req.auth.userId, entries,
        price24: Number(req.body?.price24) || 0, extra: { remote: r.ref, countedBy: r.requested_by } });
      if (out.error) return out;
      await client.query("update remote_stocktakes set status = 'applied', decided_by = $2, decided_at = now(), result = $3 where id = $1",
        [r.id, req.auth.userId, JSON.stringify(out)]);
      return { ...out, ref: r.ref };
    });
    if (result.error) return res.status(result.error === "not_found" || result.error === "item_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/stocktake/remote/:id/reject", authenticate, requirePage("stocktake"), requireManager, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update remote_stocktakes set status = 'rejected', decided_by = $3, decided_at = now(), result = $4
          where id = $1 and branch_id = $2 and status = 'pending' returning id`,
        [req.params.id, req.auth.branchId, req.auth.userId, JSON.stringify({ note: String(req.body?.note || "").slice(0, 300) })]);
      return rows[0] ? { ok: true } : { error: "not_pending" };
    });
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
//  قطعةٌ مسجّلة مباعة وُجدت في الجرد (migration 063 — قرار المالك 2026-09-29)
// ══════════════════════════════════════════════════════════════
//
// لا إضافة آلية: تُحفظ بند مراجعةٍ بفاتورتها وعميلها ومن قرأها — بلا قيدٍ
// ولا قطعة، وتبقى «مباعة» فلا تُباع ثانيةً. والمدير يقرّر بسببٍ مكتوب.
//   GET  /stocktake/sold-found
//   POST /stocktake/sold-found            { codes: [..], source }
//   POST /stocktake/sold-found/:id/decide { decision: sale_ok|returned|added, reason, returnId?, heldForCustomer?, price24? }

const soldFoundRow = (r) => ({
  id: r.id, code: r.unit_code, itemId: r.item_id, saleId: r.sale_id, saleRef: r.sale_ref, saleDate: r.sale_date,
  customerName: r.customer_name || "", foundBy: r.found_by_name || null, foundAt: r.found_at, source: r.source,
  status: r.status, heldForCustomer: !!r.held_for_customer, reason: r.reason || "", decidedBy: r.decided_by_name || null,
  decidedAt: r.decided_at, returnId: r.return_id, newCode: r.new_unit_code || null,
});

router.get("/stocktake/sold-found", authenticate, requirePage("stocktake"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select f.*, fu.name as found_by_name, du.name as decided_by_name
         from stocktake_sold_found f
         left join users fu on fu.id = f.found_by
         left join users du on du.id = f.decided_by
        where f.branch_id = $1 and (f.status = 'pending' or f.decided_at > now() - interval '30 days')
        order by (f.status = 'pending') desc, f.found_at desc limit 100`, [req.auth.branchId])).rows);
    res.json({ soldFound: rows.map(soldFoundRow) });
  } catch (err) {
    next(err);
  }
});

router.post("/stocktake/sold-found", authenticate, requirePage("stocktake"), async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : [])
    .map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 500);
  const source = ["scan", "camera", "rfid", "manual", "hidden"].includes(req.body?.source) ? req.body.source : "scan";
  if (!codes.length) return res.status(400).json({ error: "no_codes" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: units } = await client.query(
        `select u.id, u.code, u.item_id, u.sale_id, s.ref as sale_ref, s.date as sale_date, s.customer_name
           from item_units u
           join items i on i.id = u.item_id and i.branch_id = $1
           left join sales s on s.id = u.sale_id
          where upper(u.code) = any($2::text[]) and u.sold = true`,
        [req.auth.branchId, codes]
      );
      const recorded = [];
      for (const u of units) {
        const { rows } = await client.query(
          `insert into stocktake_sold_found
             (branch_id, unit_id, unit_code, item_id, sale_id, sale_ref, sale_date, customer_name, found_by, source)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           on conflict (branch_id, unit_code) where status = 'pending' do nothing
           returning *`,
          [req.auth.branchId, u.id, u.code, u.item_id, u.sale_id, u.sale_ref, u.sale_date, u.customer_name, req.auth.userId, source]
        );
        if (rows[0]) recorded.push(soldFoundRow(rows[0]));
      }
      if (recorded.length) {
        await client.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
           values ($1,'update',$2,'stocktake',null,$3)`,
          [req.auth.branchId, req.auth.userId, JSON.stringify({ soldFound: recorded.map((r) => ({ code: r.code, saleRef: r.saleRef })), source })]
        );
      }
      const known = new Set(units.map((u) => u.code.toUpperCase()));
      return { recorded, notSold: codes.filter((c) => !known.has(c)) };
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/stocktake/sold-found/:id/decide", authenticate, requirePage("stocktake"), requireManager, async (req, res, next) => {
  const body = req.body || {};
  const decision = body.decision;
  const reason = String(body.reason || "").trim().slice(0, 300);
  if (!["sale_ok", "returned", "added"].includes(decision)) return res.status(400).json({ error: "invalid_decision" });
  if (!reason) return res.status(400).json({ error: "reason_required" });
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select * from stocktake_sold_found where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const f = rows[0];
      if (!f) return { error: "not_found" };
      if (f.status !== "pending") return { error: "already_decided" };

      let returnId = null, newCode = null, journalEntryId = null;
      if (decision === "returned") {
        // المرتجع نفسه يمرّ بمساره المعتاد (قيده وضريبته وبوّابة اعتماده) — هنا يُربط برقمه فقط
        const { rows: ret } = await client.query(
          "select id from returns where id = $1 and branch_id = $2 and sale_id = $3", [body.returnId || null, req.auth.branchId, f.sale_id]);
        if (!ret[0]) return { error: "return_not_found" };
        returnId = ret[0].id;
      } else if (decision === "added") {
        // زيادة جرد بتكلفة الصنف في الدفترين برمزٍ جديد — بمعالج الجرد نفسه (قطعةٌ حرّة زائدة)
        const { rows: free } = await client.query(
          "select count(*)::int as n from item_units where item_id = $1 and sold = false and issued = false", [f.item_id]);
        const out = await applyStocktake(client, {
          branchId: req.auth.branchId, userId: req.auth.userId,
          entries: [{ itemId: f.item_id, countedQty: free[0].n + 1 }],
          price24: Number(body.price24) || 0, extra: { soldFound: f.unit_code, saleRef: f.sale_ref },
        });
        if (out.error) return out;
        journalEntryId = out.surplusJournalId;
        const { rows: nu } = await client.query(
          "select code from item_units where item_id = $1 and sold = false and issued = false order by code desc limit 1", [f.item_id]);
        newCode = nu[0]?.code || null;
      }

      const { rows: upd } = await client.query(
        `update stocktake_sold_found set status = $2, reason = $3, decided_by = $4, decided_at = now(),
                held_for_customer = $5, return_id = $6, new_unit_code = $7, journal_entry_id = $8
          where id = $1 returning *`,
        [f.id, decision, reason, req.auth.userId, decision === "sale_ok" && !!body.heldForCustomer, returnId, newCode, journalEntryId]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'stocktake',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ soldFound: f.unit_code, saleRef: f.sale_ref, decision, reason, newCode })]
      );
      return { soldFound: soldFoundRow(upd[0]) };
    });
    if (result.error) {
      const status = result.error === "not_found" || result.error === "item_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/// إقفال الشهر من الفرع نفسه، وحالة سنته (migration 061)
router.get("/fiscal/status", authenticate, requirePage("financials"), async (req, res, next) => {
  try {
    res.json(await withBranch(req.auth.branchId, (c) => fiscalStatus(c, req.auth.branchId)));
  } catch (err) {
    next(err);
  }
});
router.post("/fiscal/close-month", authenticate, requirePage("financials"), requireManager, async (req, res, next) => {
  try {
    const r = await withBranch(req.auth.branchId, (c) => closeMonth(c, req.auth.branchId, String(req.body?.period || ""), { by: req.auth.user?.name || "مدير الفرع", kind: "branch" }));
    if (r.error) return res.status(r.error === "invalid_period" ? 400 : 409).json(r);
    res.status(201).json(r);
  } catch (err) {
    next(err);
  }
});

export default router;
