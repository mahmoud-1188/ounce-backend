import { Router } from "express";
import { approvalGate } from "../domain/approvals.js";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage, requirePage, requireNotDenied } from "../middleware/auth.js";
import { postJournalEntry } from "../domain/journal.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight } from "../domain/weight.js";

import { cleanSetParts } from "../domain/setParts.js";
import { codeRemnant } from "../domain/remnants.js";
import { insertUnit, nextItemRefNum } from "../domain/itemCodes.js";

const router = Router();


router.use("/lots", authenticate, requirePage("addGoods"), requireNotDenied("addGoods"));

const KARATS = [24, 22, 21, 18, 14];
const PURITY = { 24: 1, 22: 22 / 24, 21: 21 / 24, 18: 18 / 24, 14: 14 / 24 };

/**
 * POST /api/lots/:id/items — إضافة أصناف مُكوَّدة جديدة لدفعة (lot)
 * مفتوحة — المسار الخلفي الحقيقي المفقود لـhandleAddItems في
 * GoldInventoryApp.jsx (راجع تعليق migration 028_lot_item_coding.sql
 * للسياق الكامل). نظير AddGoodsPage.jsx/handleAddItems بالضبط، لكن يكتب
 * items/item_units حقيقيين بدل window.storage.
 *
 * ⚠ بلا أي قيد وزن جديد في gold_ledger_entries: وزن الدفعة دخل حساب 1210
 * بالفعل عند تسجيل الشراء نفسه (purchases.routes.js، سطر "دفتر الوزن").
 * التكويد هنا هو فهرسة/تقطيع فقط (كم قطعة، أي تصنيف، أي أجرة لكل قطعة)
 * لوزنٍ داخل 1210 أصلًا — لا إعادة تصنيف حساب كتحويل الكسر (1230→1210)
 * ولا قيمة جديدة تدخل الدفاتر. يطابق تمامًا غياب أي postWeight إضافي في
 * دالة التكويد المقابلة بالمرجع (خلافًا لـhandleReceiveShipment وتحويل
 * الكسر، وكلاهما ينقل وزنًا بين حسابين فعليًا).
 *
 * body: { rows: [{ categoryId, weight, stonesWeight?, quantity?,
 *                   costPerGram?, workmanshipPerUnit?, isSet?, setPieces? }],
 *         distributionMode?: "per_gram" | "per_item" | "by_karat" }
 *
 * الأجرة: كل صف يحمل workmanshipPerUnit يدويًّا (كما تُدخله الشاشة)، ثم
 * يُضاف له نصيبه من workmanship_total المتبقي للدفعة (workmanship_total -
 * workmanship_allocated) موزَّعًا بنفس منطق شاشة AddGoodsPage.jsx بالضبط
 * (per_gram: بالوزن الكلي للصف، per_item: بعدد القطع، by_karat: بالوزن
 * الخالص). المتبقي محسوبٌ من عمود workmanship_allocated الحقيقي (لا من
 * قيمة NaN كانت تُقرأ محليًا من حقل لا وجود له في قاعدة البيانات) — هذا
 * بالضبط ما يمنع ازدواج الأجرة عند التكويد على دفعات من نفس lot.
 */
/** خصائص الحجر والساعة (migration 054) — نصوصٌ قصيرة وأرقام، وما سواها يُسقط */
function cleanAttrs(a) {
  if (!a || typeof a !== "object") return null;
  const txt = (v, n = 60) => (v == null ? "" : String(v).trim().slice(0, n));
  const out = {};
  if (a.gem && typeof a.gem === "object") {
    const g = { carat: Number(a.gem.carat) || 0, clarity: txt(a.gem.clarity, 20), color: txt(a.gem.color, 20), cut: txt(a.gem.cut, 30), lab: txt(a.gem.lab, 30), certNo: txt(a.gem.certNo, 40) };
    if (g.carat > 0 || g.certNo || g.clarity || g.color) out.gem = g;
  }
  if (a.watch && typeof a.watch === "object") {
    const w = { brand: txt(a.watch.brand, 40), model: txt(a.watch.model, 40), serial: txt(a.watch.serial, 40), warrantyMonths: Math.max(0, Math.round(Number(a.watch.warrantyMonths) || 0)) };
    if (w.brand || w.serial) out.watch = w;
  }
  return Object.keys(out).length ? out : null;
}

/// تكويد قطعٍ من دفعة — مشتركٌ بين الفرع (POST /lots/:id/items) والإدارة (تكويد دفعةٍ أُرسلت لها)
async function codeLotItems(client, { branchId, userId, lotId, rows, distributionMode, viaHq = false }) {
    const { rows: lotRows } = await client.query(
      "select * from lots where id = $1 and branch_id = $2 for update",
      [lotId, branchId]
    );
    const lot = lotRows[0];
    if (!lot) return { error: "lot_not_found" };
    if (lot.status !== "open") return { error: "lot_not_open" };
    // تكويد الإدارة (migration 069): الدفعة المُرسلة للإدارة تكوّدها الإدارة وحدها، وفرعٌ نموذجه «الإدارة تكوّد» لا يكوّد
    if (viaHq && lot.coding_at !== "hq") return { error: "lot_not_at_hq" };
    if (!viaHq && lot.coding_at === "hq") return { error: "lot_at_hq" };
    if (!viaHq && lot.source !== "opening") {
      const { rows: cm } = await client.query("select coding_model from branch_settings where branch_id = $1", [branchId]);
      if (cm[0]?.coding_model === "hq") return { error: "coding_by_hq_only" };
    }
    if (!KARATS.includes(Number(lot.karat))) return { error: "lot_missing_karat" };

    // ⚠ الدفعة الافتتاحية (migration 035) تُكوَّد في وضع الافتتاح وحده —
    //   بعد إطفائه لا يُدخل رصيدٌ افتتاحي على أنه تشغيل.
    const isOpeningLot = lot.source === "opening";
    if (isOpeningLot) {
      const { rows: stRows } = await client.query(
        "select opening_mode from branch_settings where branch_id = $1",
        [branchId]
      );
      if (!stRows[0]?.opening_mode) return { error: "opening_mode_off" };
    }

    // تحقق التصنيفات كلها دفعة واحدة قبل أي إدراج.
    const categoryIds = [...new Set(rows.map((r) => r.categoryId))];
    const { rows: catRows } = await client.query(
      `select id from categories where branch_id = $1 or branch_id is null`,
      [branchId]
    );
    const validCategoryIds = new Set(catRows.map((c) => c.id));
    for (const cid of categoryIds) {
      if (!validCategoryIds.has(cid)) return { error: "category_not_found" };
    }

    // ⚠ يوم العمل الحالي المفتوح، لا يوم الشراء الأصلي للدفعة: التكويد
    // قد يحدث في يومٍ لاحق تمامًا عن يوم تسجيل الشراء (نفس الفارق بين
    // lot.business_day_id وقت الشراء وbusinessDayId هنا وقت التكويد).
    const { rows: dayRows } = await client.query(
      `select id from business_days where branch_id = $1 and status = 'open'
         order by opened_at desc limit 1`,
      [branchId]
    );
    const businessDayId = dayRows[0]?.id || null;

    const karat = Number(lot.karat);
    const rowQty = (r) => Math.max(1, Number(r.quantity) || 1);
    const rowWeightQty = (r) => Number(r.weight) * rowQty(r);
    const rowFine = (r) => rowWeightQty(r) * (PURITY[karat] || karat / 24);

    const remainingWorkmanship = Math.max(
      0,
      Number(lot.workmanship_total) - Number(lot.workmanship_allocated)
    );
    let denom = 0;
    if (remainingWorkmanship > 0) {
      if (distributionMode === "per_item") denom = rows.reduce((a, r) => a + rowQty(r), 0);
      else if (distributionMode === "by_karat") denom = rows.reduce((a, r) => a + rowFine(r), 0);
      else denom = rows.reduce((a, r) => a + rowWeightQty(r), 0);
    }
    const shareForRow = (r) => {
      if (remainingWorkmanship <= 0 || denom <= 0) return 0;
      const numer = distributionMode === "per_item" ? rowQty(r) : distributionMode === "by_karat" ? rowFine(r) : rowWeightQty(r);
      return (remainingWorkmanship * numer) / denom / rowQty(r); // نصيب الوحدة الواحدة
    };

    let nextRefNum = await nextItemRefNum(client, branchId);

    const createdItems = [];
    let allocatedNow = 0;

    for (const row of rows) {
      const quantity = rowQty(row);
      const allocatedWorkmanship = shareForRow(row);
      const totalWorkmanship = (Number(row.workmanshipPerUnit) || 0) + allocatedWorkmanship;
      const costPerGram = row.costPerGram != null ? Number(row.costPerGram) : Number(lot.cost_per_gram) || null;
      const ref = `ITM-${String(nextRefNum++).padStart(6, "0")}`;
      const attrs = cleanAttrs(row.attrs);
      const setParts = cleanSetParts(row.setParts ?? row.setPieces);

      const { rows: itemRows } = await client.query(
        `insert into items
           (branch_id, ref, lot_id, category_id, karat, weight, stones_weight,
            cost_per_gram, workmanship, lot_workmanship_share, from_scrap,
            business_day_id, created_by, attrs, set_parts)
         values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,false, $11,$12, $13, $14)
         returning id, ref, karat, weight, stones_weight, cost_per_gram,
                   workmanship, lot_workmanship_share, date_added, attrs`,
        [
          branchId, ref, lot.id, row.categoryId, karat,
          Number(row.weight), Number(row.stonesWeight) || 0,
          costPerGram, totalWorkmanship, allocatedWorkmanship,
          businessDayId, userId, attrs ? JSON.stringify(attrs) : null,
          JSON.stringify(setParts),
        ]
      );
      const newItem = itemRows[0];

      const units = [];
      for (let i = 0; i < quantity; i++) {
        const code = quantity > 1 ? `${ref}-${i + 1}` : ref;
        units.push(await insertUnit(client, newItem.id, code));
      }

      allocatedNow += allocatedWorkmanship * quantity;
      createdItems.push({
        id: newItem.id,
        ref: newItem.ref,
        lotId: lot.id,
        categoryId: row.categoryId,
        karat: newItem.karat,
        weight: Number(newItem.weight),
        stonesWeight: Number(newItem.stones_weight) || 0,
        costPerGram: newItem.cost_per_gram != null ? Number(newItem.cost_per_gram) : null,
        workmanship: Number(newItem.workmanship) || 0,
        lotWorkmanshipShare: Number(newItem.lot_workmanship_share) || 0,
        attrs: newItem.attrs || null,
        fromScrap: false,
        dateAdded: newItem.date_added,
        units: units.map((u) => ({ id: u.id, code: u.code, printed: !!u.printed, sold: !!u.sold })),
      });
    }

    if (allocatedNow > 0) {
      await client.query(
        `update lots set workmanship_allocated = workmanship_allocated + $1 where id = $2`,
        [allocatedNow, lot.id]
      );
    }

    // ── الدفعة الافتتاحية تنمو بما يُكوَّد، ويدخل الدفترين هنا لا عند
    //    شراء (لا شراء): وزنًا إلى 1210، ونقدًا مخزونًا مقابل رأس المال.
    let openingEntry = null;
    if (isOpeningLot) {
      const pieces = createdItems.reduce((a, it) => a + it.units.length, 0);
      const weightNow = createdItems.reduce((a, it) => a + it.weight * it.units.length, 0);
      const goldValue = roundMoney(createdItems.reduce((a, it) => a + (it.costPerGram || 0) * it.weight * it.units.length, 0));
      const value = roundMoney(createdItems.reduce((a, it) => a + ((it.costPerGram || 0) * it.weight + (it.workmanship || 0)) * it.units.length, 0));
      const { rows: upd } = await client.query(
        `update lots set weight = coalesce(weight, 0) + $1,
                         gold_cost = coalesce(gold_cost, 0) + $2,
                         total_cost = coalesce(total_cost, 0) + $3
          where id = $4 returning weight, gold_cost, total_cost`,
        [weightNow, goldValue, value, lot.id]
      );
      // ⚠ فترة التجهيز (migration 073): لا قيد ولا حركة وزن — يُرحَّل الافتتاح كلّه يوم «بدء التشغيل»
      const { rows: ls } = await client.query("select coalesce(ledger_state, 'live') as s from branch_settings where branch_id = $1", [branchId]);
      const inSetup = ls[0]?.s === "setup";
      if (inSetup) await client.query("update lots set opening_posted = false where id = $1", [lot.id]);
      else await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight,
            from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,'opening_inventory',$3,$4,$5, null,'1210', 'lots',$6,$7,$8)`,
        [branchId, businessDayId, karat, weightNow, fineWeight(weightNow, karat), lot.id,
          `افتتاحي ${lot.ref}`, userId]
      );
      let journalEntryId = null;
      if (value > 0 && !inSetup) {
        journalEntryId = await postJournalEntry(client, {
          branchId: branchId, businessDayId, opType: "opening_inventory",
          refTable: "lots", refId: lot.id,
          description: `مخزون افتتاحي مكوَّد — ${lot.ref} — ${pieces} قطعة`,
          createdBy: userId,
          lines: [
            { account: "1210", side: "debit", amount: value },
            { account: "3100", side: "credit", amount: value },
          ],
        });
      }
      openingEntry = {
        value, weight: weightNow, pieces, journalEntryId,
        lot: { weight: Number(upd[0].weight), goldCost: Number(upd[0].gold_cost), totalCost: Number(upd[0].total_cost) },
      };
    }

    return { items: createdItems, opening: openingEntry };
}

/// إرسال دفعةٍ للتكويد في الإدارة (migration 069) — لا قيد: الوزن باقٍ في 1210 عند الفرع حتى يعود قطعًا.
///   فرعٌ نموذجه «الفرع يكوّد» لا يرسل، والدفعة الافتتاحية تُكوَّد في وضع الافتتاح هنا.
// علامة طباعة الملصق على القطع برموزها (migration 071) — لا تخرج قطعةٌ بلا ملصقها
router.post("/items/units/printed", authenticate, requireAnyPage("addGoods", "printing", "inventory", "branchTransfers"), async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 500);
  const printed = req.body?.printed !== false;
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update item_units u set printed = $3 from items i
          where i.id = u.item_id and i.branch_id = $1 and upper(u.code) = any($2::text[])
          returning u.code`, [req.auth.branchId, codes, printed]);
      return rows;
    });
    res.json({ updated: rows.length });
  } catch (err) { next(err); }
});

// إعادة طباعة ملصقٍ مطبوع أو استبدال رقاقته (migration 076) — بموافقة تُسجَّل
router.post("/items/units/reprint", authenticate, requireAnyPage("printing", "addGoods", "inventory"), async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 200);
  const action = ["reprint", "replace", "unmark"].includes(req.body?.action) ? req.body.action : "reprint";
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `select u.code from item_units u join items i on i.id = u.item_id
          where i.branch_id = $1 and upper(u.code) = any($2::text[])`, [req.auth.branchId, codes]);
      if (rows.length !== codes.length) return { error: "unit_not_found" };
      const label = action === "replace" ? "استبدال رقاقة" : action === "unmark" ? "إلغاء علامة الطباعة" : "إعادة طباعة ملصق";
      const gate = await approvalGate(c, req.auth, {
        kind: "label_reprint", amount: 0, approvalId: req.body?.approvalId || null,
        note: `${label}: ${codes.slice(0, 6).join(" · ")}${codes.length > 6 ? ` +${codes.length - 6}` : ""}${req.body?.reason ? ` — ${String(req.body.reason).slice(0, 80)}` : ""}`,
        payload: { codes, action, reason: req.body?.reason || null },
      });
      if (gate.error) return gate;
      if (gate.pending) return { approvalPending: gate.pending };
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'item_units',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ action: `label_${action}`, codes, approvalId: gate.approvalId || null })]);
      return { ok: true, codes, action };
    });
    if (out.approvalPending) return res.status(202).json(out);
    if (out.error) return res.status(out.error === "unit_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

/// إلغاء تكويد قطعٍ (migration 078): وزنها يعود «لم يُكوَّد» في دفعتها المفتوحة، أو يخرج من الافتتاحي ما دام
///   الفرع في فترة التجهيز ولم يُرحَّل الافتتاح. الرمز يُلغى نهائيًّا، وكل طلبٍ باعتمادٍ وسببٍ مكتوب.
router.post("/items/units/uncode", authenticate, requireAnyPage("addGoods", "inventory"), async (req, res, next) => {
  const codes = [...new Set((Array.isArray(req.body?.codes) ? req.body.codes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 100);
  const reason = String(req.body?.reason || "").trim().slice(0, 200);
  if (!codes.length) return res.status(400).json({ error: "codes_required" });
  if (reason.length < 4) return res.status(400).json({ error: "reason_required" });
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `select u.id as unit_id, u.code, u.sold, u.issued, u.held, u.printed, u.epc,
                (u.transfer_id is not null and t.status = 'sent') as in_transfer,
                i.id as item_id, i.ref, i.weight, i.karat, i.cost_per_gram, i.workmanship, i.lot_workmanship_share,
                i.remnant, i.remnant_of, coalesce(u.reserved_for, i.reserved_for) as reserved_for, i.from_scrap,
                l.id as lot_id, l.ref as lot_ref, l.status as lot_status, l.source as lot_source, l.coding_at, l.opening_posted
           from item_units u join items i on i.id = u.item_id
           left join lots l on l.id = i.lot_id
           left join branch_transfers t on t.id = u.transfer_id
          where i.branch_id = $1 and upper(u.code) = any($2::text[])
          for update of u`, [req.auth.branchId, codes]);
      if (rows.length !== codes.length) return { error: "unit_not_found" };
      const { rows: lk } = await c.query("select locked from stocktake_locks where branch_id = $1", [req.auth.branchId]);
      if (lk[0]?.locked) return { error: "stocktake_locked" };
      const { rows: ls } = await c.query("select coalesce(ledger_state, 'live') as s from branch_settings where branch_id = $1", [req.auth.branchId]);
      const inSetup = ls[0]?.s === "setup";
      for (const r of rows) {
        const bad = r.sold || r.issued || r.held ? "unit_not_available"
          : r.in_transfer ? "unit_in_transfer"
          : r.remnant || r.remnant_of || r.from_scrap ? "not_from_lot"
          : r.reserved_for ? "item_reserved"
          : !r.lot_id ? "not_from_lot"
          : r.lot_status !== "open" ? "lot_closed"
          : r.coding_at === "hq" ? "lot_at_hq"
          : r.lot_source === "opening" && !(inSetup && r.opening_posted === false) ? "opening_posted"
          : null;
        if (bad) return { error: bad, code: r.code };
      }
      // ما عُدّل وزنه بإصلاحٍ أو تسويةٍ فيه ذهبٌ من غير دفعته
      const itemIds = [...new Set(rows.map((r) => r.item_id))];
      const { rows: adj } = await c.query("select 1 from weight_adjustments where item_id = any($1::uuid[]) limit 1", [itemIds]);
      if (adj.length) return { error: "weight_adjusted" };
      const { rows: stf } = await c.query("select 1 from stocktake_sold_found where unit_id = any($1::uuid[]) limit 1", [rows.map((r) => r.unit_id)]);
      if (stf.length) return { error: "unit_in_stocktake" };

      const weight = rows.reduce((a, r) => a + Number(r.weight), 0);
      const cost = roundMoney(rows.reduce((a, r) => a + (Number(r.cost_per_gram) || 0) * Number(r.weight) + (Number(r.workmanship) || 0), 0));
      const gate = await approvalGate(c, req.auth, {
        kind: "item_uncode", amount: cost, approvalId: req.body?.approvalId || null,
        note: `إلغاء تكويد ${codes.slice(0, 6).join(" · ")}${codes.length > 6 ? ` +${codes.length - 6}` : ""} — ${Math.round(weight * 1000) / 1000} جم — ${reason}`,
        payload: { codes, reason },
      });
      if (gate.error) return gate;
      if (gate.pending) return { approvalPending: gate.pending };

      // الدفعة: حصّة الأجور تعود غير موزَّعة، والافتتاحي في التجهيز ينقص وزنه وقيمته
      const byLot = new Map();
      for (const r of rows) {
        const g = byLot.get(r.lot_id) || { opening: r.lot_source === "opening", share: 0, weight: 0, gold: 0, total: 0 };
        g.share += Number(r.lot_workmanship_share) || 0;
        g.weight += Number(r.weight);
        g.gold += (Number(r.cost_per_gram) || 0) * Number(r.weight);
        g.total += (Number(r.cost_per_gram) || 0) * Number(r.weight) + (Number(r.workmanship) || 0);
        byLot.set(r.lot_id, g);
      }
      for (const [lotId, g] of byLot) {
        if (g.opening) await c.query(
          `update lots set weight = greatest(0, coalesce(weight, 0) - $2), gold_cost = greatest(0, coalesce(gold_cost, 0) - $3),
                           total_cost = greatest(0, coalesce(total_cost, 0) - $4) where id = $1`,
          [lotId, g.weight, roundMoney(g.gold), roundMoney(g.total)]);
        else if (g.share > 0) await c.query("update lots set workmanship_allocated = greatest(0, workmanship_allocated - $2) where id = $1", [lotId, roundMoney(g.share)]);
      }
      await c.query("delete from item_units where id = any($1::uuid[])", [rows.map((r) => r.unit_id)]);
      // صنفٌ لم يبقَ له قطعةٌ ولا فاتورة يُحذف، وإلا بقي لسجلّ ما بِيع منه
      await c.query(
        `delete from items i where i.id = any($1::uuid[])
            and not exists (select 1 from item_units u where u.item_id = i.id)
            and not exists (select 1 from sale_lines s where s.item_id = i.id)`, [itemIds]);
      await c.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'delete',$2,'item_units',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ action: "item_uncode", codes, weight, reason, lots: rows.map((r) => r.lot_ref), approvalId: gate.approvalId || null })]);
      return { ok: true, codes, weight: Math.round(weight * 1000) / 1000, pieces: rows.length, printed: rows.some((r) => r.printed), lots: [...new Set(rows.map((r) => r.lot_ref))] };
    });
    if (out.approvalPending) return res.status(202).json(out);
    if (out.error) return res.status(out.error === "unit_not_found" ? 404 : 409).json(out);
    res.json(out);
  } catch (err) { next(err); }
});

router.post("/lots/:id/send-to-hq", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from lots where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const lot = rows[0];
      if (!lot) return { error: "lot_not_found" };
      if (lot.status !== "open") return { error: "lot_not_open" };
      if (lot.source === "opening") return { error: "opening_lot_codes_here" };
      if (lot.coding_at === "hq") return { error: "lot_at_hq" };
      const { rows: cm } = await client.query("select coding_model from branch_settings where branch_id = $1", [req.auth.branchId]);
      if (cm[0]?.coding_model === "branch") return { error: "coding_by_branch_only" };
      const { rows: up } = await client.query(
        "update lots set coding_at = 'hq', sent_to_hq_at = now(), sent_to_hq_by = $2 where id = $1 returning id, ref, coding_at, sent_to_hq_at",
        [lot.id, req.auth.userId]);
      await client.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'lots',$3,$4)`,
        [req.auth.branchId, req.auth.userId, lot.id, JSON.stringify({ sentToHq: lot.ref })]);
      return { lot: up[0] };
    });
    if (result.error) return res.status(result.error === "lot_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/// تكويدٌ بالجرام بلا مورد (باقة «بدون محاسبة»): كل قطعةٍ بعيارها ووزنها وعددها فقط — لا دفعة ولا تكلفة ولا مصنعية
/// ولا قيدٌ مالي. وزنها يدخل 1210 فتظهر في الجرد ورصيد الجرام.
router.post("/items/direct", authenticate, requirePage("addGoods"), requireNotDenied("addGoods"), async (req, res, next) => {
  if (req.auth.storePackage !== "no_accounting") return res.status(403).json({ error: "direct_coding_needs_inventory_package" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const KAR = [24, 22, 21, 18, 14];
  if (!rows.length || rows.length > 100) return res.status(400).json({ error: "invalid_rows" });
  for (const r of rows) {
    if (!KAR.includes(Number(r.karat)) || !(Number(r.weight) > 0) || !r.categoryId) return res.status(400).json({ error: "invalid_row" });
    if ((Number(r.stonesWeight) || 0) < 0 || Math.max(1, Math.floor(Number(r.quantity) || 1)) > 500) return res.status(400).json({ error: "invalid_row" });
  }
  try {
    const out = await withBranch(req.auth.branchId, async (client) => {
      const { rows: day } = await client.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      const dayId = day[0]?.id || null;
      let n = await nextItemRefNum(client, req.auth.branchId);
      const created = [];
      for (const r of rows) {
        const karat = Number(r.karat), weight = Number(r.weight), qty = Math.max(1, Math.floor(Number(r.quantity) || 1));
        const ref = `ITM-${String(n++).padStart(6, "0")}`;
        const { rows: it } = await client.query(
          `insert into items (branch_id, ref, category_id, karat, weight, stones_weight, cost_per_gram, workmanship, lot_workmanship_share, from_scrap, business_day_id, created_by, set_parts)
           values ($1,$2,$3,$4,$5,$6,0,0,0,false,$7,$8,$9) returning id, ref, karat, weight, stones_weight, date_added`,
          [req.auth.branchId, ref, r.categoryId, karat, weight, Number(r.stonesWeight) || 0, dayId, req.auth.userId, JSON.stringify(cleanSetParts(r.setParts))]);
        const units = [];
        for (let i = 0; i < qty; i++) units.push(await insertUnit(client, it[0].id, qty > 1 ? `${ref}-${i + 1}` : ref));
        await client.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,'direct_coding',$3,$4,$5,null,'1210','items',$6,$7,$8)`,
          [req.auth.branchId, dayId, karat, weight * qty, fineWeight(weight * qty, karat), it[0].id, `تكويد بالجرام ${ref}`, req.auth.userId]);
        created.push({
          id: it[0].id, ref: it[0].ref, lotId: null, categoryId: r.categoryId, karat, weight: Number(it[0].weight), stonesWeight: Number(it[0].stones_weight) || 0,
          costPerGram: 0, workmanship: 0, lotWorkmanshipShare: 0, dateAdded: it[0].date_added,
          units: units.map((u) => ({ id: u.id, code: u.code, printed: !!u.printed, sold: !!u.sold })),
        });
      }
      return { items: created };
    });
    res.status(201).json(out);
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "category_not_found" });
    next(err);
  }
});

/// إقفال دفعة المورد: المكوَّد يُقارن بالمشترى بالميزان. داخل تسامح الميزان «مطابق»، وفوق تسامح فرق التكويد
/// يلزم سبب. العجز يخرج من 1210 وزنًا ويُبوَّب 5330 بتكلفة الدفعة، والزيادة تدخل 1210 وتُبوَّب 4320 —
/// والمخزون دوريّ، فالقيد إعادة تبويبٍ من المشتريات (5110) لا يغيّر الربح مرّتين.
router.post("/lots/:id/close", async (req, res, next) => {
  const note = String(req.body?.note || "").trim().slice(0, 300);
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from lots where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const lot = rows[0];
      if (!lot) return { error: "lot_not_found" };
      if (lot.status !== "open") return { error: "lot_not_open" };
      if (lot.source === "opening") return { error: "opening_lot_closes_with_opening" };
      if (lot.coding_at === "hq") return { error: "lot_at_hq" };
      const { rows: cw } = await client.query(
        `select coalesce(sum(i.weight * (select count(*) from item_units u where u.item_id = i.id)), 0) as w
           from items i where i.lot_id = $1`, [lot.id]);
      const received = Number(lot.weight) || 0, coded = Math.round(Number(cw[0].w) * 1000) / 1000;
      const diff = Math.round((received - coded) * 1000) / 1000;   // موجب عجز، سالب زيادة
      const { rows: st } = await client.query("select sale_prefs from branch_settings where branch_id = $1", [req.auth.branchId]);
      const w = st[0]?.sale_prefs?.wastage || {};
      const tolG = Math.max(0.005, Number.isFinite(Number(w.receiveTolG)) ? Number(w.receiveTolG) : 0.05);
      const tolPct = Number.isFinite(Number(w.codingTolPct)) ? Number(w.codingTolPct) : 0.1;
      const pct = received > 0 ? Math.round(Math.abs(diff) / received * 10000) / 100 : 0;
      const state = Math.abs(diff) <= tolG + 1e-9 ? "match" : diff > 0 ? "shortage" : "surplus";
      if (state !== "match" && pct > tolPct && note.length < 3) return { error: "reason_required", diff, pct };
      const { rows: day } = await client.query("select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1", [req.auth.branchId]);
      const dayId = day[0]?.id || null;
      let journalEntryId = null;
      // كل فرقٍ فوق نصف ملّيغرام يُرحَّل ولو داخل التسامح، وإلا انجرف وزن 1210 عن وزن القطع
      if (Math.abs(diff) > 0.0005) {
        const short = diff > 0, wt = Math.abs(diff);
        const op = short ? "coding_variance" : "coding_surplus";
        const label = `${lot.ref} — فرق التكويد ${short ? "عجز" : "زيادة"} ${wt} جم${note ? ` — ${note}` : ""}`;
        await client.query(
          `insert into gold_ledger_entries (branch_id, business_day_id, op_type, karat, weight, fine_weight, from_account, to_account, ref_table, ref_id, note, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'lots',$9,$10,$11)`,
          [req.auth.branchId, dayId, op, lot.karat, wt, fineWeight(wt, lot.karat), short ? "1210" : null, short ? null : "1210", lot.id, label, req.auth.userId]);
        const value = roundMoney(wt * (Number(lot.cost_per_gram) || 0));
        if (value > 0) journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId: dayId, opType: op, refTable: "lots", refId: lot.id, description: label, createdBy: req.auth.userId,
          lines: short
            ? [{ account: "5330", side: "debit", amount: value }, { account: "5110", side: "credit", amount: value }]
            : [{ account: "5110", side: "debit", amount: value }, { account: "4320", side: "credit", amount: value }],
        });
      }
      const { rows: up } = await client.query(
        `update lots set status = 'closed', closed_at = now(), closed_by = $2, entered_weight = $3, wastage_weight = $4, surplus_weight = $5, close_note = $6
          where id = $1 returning *`,
        [lot.id, req.auth.userId, coded, diff > 0.0005 ? diff : 0, diff < -0.0005 ? -diff : 0, note || null]);
      await client.query(`insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'update',$2,'lots',$3,$4)`,
        [req.auth.branchId, req.auth.userId, lot.id, JSON.stringify({ closed: lot.ref, received, coded, diff, note })]);
      return { lot: up[0], received, coded, diff, state, pct, journalEntryId };
    });
    if (result.error) return res.status(result.error === "lot_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/// استرجاع دفعةٍ من الإدارة قبل تكويدها كلّها — يكوّدها الفرع (ما لم يكن نموذجه «الإدارة تكوّد»)
router.post("/lots/:id/recall", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: cm } = await client.query("select coding_model from branch_settings where branch_id = $1", [req.auth.branchId]);
      if (cm[0]?.coding_model === "hq") return { error: "coding_by_hq_only" };
      const { rows } = await client.query(
        "update lots set coding_at = 'branch' where id = $1 and branch_id = $2 and coding_at = 'hq' returning id, ref, coding_at",
        [req.params.id, req.auth.branchId]);
      return rows[0] ? { lot: rows[0] } : { error: "lot_not_at_hq" };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/lots/:id/items", async (req, res, next) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const distributionMode = ["per_gram", "per_item", "by_karat"].includes(body.distributionMode)
    ? body.distributionMode
    : "per_gram";

  if (!rows.length) return res.status(400).json({ error: "no_rows" });
  for (const r of rows) {
    if (!(Number(r.weight) > 0)) return res.status(400).json({ error: "missing_field", field: "weight", fieldLabel: "الوزن" });
    if (!r.categoryId) return res.status(400).json({ error: "missing_field", field: "categoryId", fieldLabel: "التصنيف" });
  }

  try {
    const result = await withBranch(req.auth.branchId, (client) => codeLotItems(client, {
      branchId: req.auth.branchId, userId: req.auth.userId, lotId: req.params.id, rows, distributionMode,
    }));

    if (result.error) {
      const status = result.error === "lot_not_found" || result.error === "category_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/items/:id/code-remnant { pieces: [{ categoryId, weight, setParts? }] }
 * تكويد بقايا طقم (المرجع 5.2.0: RemnantCodingForm): قطعٌ مجموع أوزانها وزنُ البقايا
 * — الحارس يرفض غيره — بتكلفة جرام البقايا نفسها، ومصنعيّتها موزّعةٌ بالوزن.
 * الذهب لا يغادر 1210 (المشغول يبقى مشغولًا بوزنه) فلا قيد ولا حركة وزن؛
 * وحدة البقايا تُخرج (issued) ويبقى سطرها أثرًا.
 */
router.post("/items/:id/code-remnant", authenticate, requirePage("addGoods"), requireNotDenied("addGoods"), async (req, res, next) => {
  const pieces = Array.isArray(req.body?.pieces) ? req.body.pieces : [];
  if (!pieces.length) return res.status(400).json({ error: "no_pieces" });
  for (const p of pieces) {
    if (!p.categoryId) return res.status(400).json({ error: "missing_field", field: "categoryId" });
    if (!(Number(p.weight) > 0)) return res.status(400).json({ error: "missing_field", field: "weight" });
  }
  try {
    const result = await withBranch(req.auth.branchId, (client) =>
      codeRemnant(client, { branchId: req.auth.branchId, itemId: req.params.id, pieces, userId: req.auth.userId }));
    if (result.error) return res.status(result.error === "item_not_found" ? 404 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export { codeLotItems };
export default router;
