import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage, requireManager, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight, roundWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import { getOpenBusinessDay } from "../domain/saleOps.js";

const router = Router();
const KARATS = [24, 22, 21, 18, 14];

/**
 * أرصدة الموردين الافتتاحية (migration 046).
 *   GET  /suppliers/openings              — كل الأرصدة (للكشف)
 *   POST /suppliers/:id/openings { kind: gold|cash, side: owed|due, karat, weight, amount, note }
 *        الذهب يُقيَّم بـ amount (قيمته بالعملة) لأن 2110 بالعملة، ووزنه يدخل كشف المورد.
 *   POST /suppliers/openings/:id/void     — عكس القيد
 */
function shape(r) {
  return {
    id: r.id, supplierId: r.supplier_id, kind: r.kind, side: r.side,
    karat: r.karat, weight: Number(r.weight) || 0, fineWeight: Number(r.fine_weight) || 0,
    amount: Number(r.amount) || 0, note: r.note || "", date: r.created_at,
    voided: !!r.voided_at, voidedAt: r.voided_at, journalEntryId: r.journal_entry_id,
  };
}

function linesFor(o) {
  const a = Number(o.amount);
  if (o.side === "owed") {
    return [
      { account: "3100", side: "debit", amount: a },
      { account: o.kind === "gold" ? "2110" : "2120", side: "credit", amount: a },
    ];
  }
  return [
    { account: "1320", side: "debit", amount: a },
    { account: "3100", side: "credit", amount: a },
  ];
}

router.get("/suppliers/openings", authenticate, requireAnyPage("suppliers", "supplierLedger", "openingBalance"), async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) =>
      (await c.query("select * from supplier_openings where branch_id = $1 order by created_at", [req.auth.branchId])).rows
    );
    res.json({ openings: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post("/suppliers/:id/openings", authenticate, requireAnyPage("suppliers", "openingBalance"), requireManager, requireNotDenied("purchase"), async (req, res, next) => {
  const b = req.body || {};
  const kind = b.kind === "gold" ? "gold" : b.kind === "cash" ? "cash" : null;
  const side = b.side === "due" ? "due" : b.side === "owed" ? "owed" : null;
  if (!kind || !side) return res.status(400).json({ error: "invalid_opening_kind" });
  const amount = roundMoney(Number(b.amount) || 0);
  const karat = kind === "gold" ? Number(b.karat) : null;
  const weight = kind === "gold" ? roundWeight(Number(b.weight) || 0) : 0;
  if (kind === "gold" && (!KARATS.includes(karat) || !(weight > 0))) return res.status(400).json({ error: "invalid_weight" });
  if (!(amount > 0)) return res.status(400).json({ error: "invalid_amount" });
  const fine = kind === "gold" ? fineWeight(weight, karat) : 0;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 300) : "";

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: sup } = await client.query("select id, name from suppliers where id = $1 and branch_id = $2", [req.params.id, req.auth.branchId]);
      if (!sup[0]) return { error: "supplier_not_found" };
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const { rows } = await client.query(
        `insert into supplier_openings (branch_id, supplier_id, kind, side, karat, weight, fine_weight, amount, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [req.auth.branchId, sup[0].id, kind, side, karat, weight, fine, amount, note || null, req.auth.userId]
      );
      const o = rows[0];
      const label = `رصيد افتتاحي — ${sup[0].name} — ${kind === "gold" ? "ذهب" : "نقد"} ${side === "owed" ? "علينا له" : "لنا عنده"}`;
      const entryId = await postJournalEntry(client, {
        branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "supplier_opening",
        refTable: "supplier_openings", refId: o.id, description: label, createdBy: req.auth.userId, lines: linesFor(o),
      });
      await client.query("update supplier_openings set journal_entry_id = $2 where id = $1", [o.id, entryId]);
      // الكشف الرسمي: علينا له = increase · لنا عنده = decrease (رصيدٌ مدين)
      await client.query(
        `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,$5,$6,'supplier_openings',$7,$8,$9)`,
        [req.auth.branchId, sup[0].id, day?.id || null, side === "owed" ? "increase" : "decrease",
         kind === "gold" ? fine : 0, kind === "cash" ? amount : 0, o.id, label, req.auth.userId]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'create',$2,'supplier_openings',$3,$4)`,
        [req.auth.branchId, req.auth.userId, o.id, JSON.stringify({ kind, side, karat, weight, amount })]
      );
      return { opening: shape({ ...o, journal_entry_id: entryId }) };
    });
    if (result.error) return res.status(result.error === "supplier_not_found" ? 404 : 409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/suppliers/openings/:id/void", authenticate, requireAnyPage("suppliers", "openingBalance"), requireManager, requireNotDenied("purchase"), async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from supplier_openings where id = $1 and branch_id = $2 for update", [req.params.id, req.auth.branchId]);
      const o = rows[0];
      if (!o) return { error: "opening_not_found" };
      if (o.voided_at) return { error: "already_voided" };
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const reversed = linesFor(o).map((l) => ({ ...l, side: l.side === "debit" ? "credit" : "debit" }));
      const entryId = await postJournalEntry(client, {
        branchId: req.auth.branchId, businessDayId: day?.id || null, opType: "supplier_opening_void",
        refTable: "supplier_openings", refId: o.id, description: "إلغاء رصيد افتتاحي لمورد", createdBy: req.auth.userId, lines: reversed,
      });
      await client.query(
        `insert into supplier_ledger (branch_id, supplier_id, business_day_id, direction, gold_fine_grams, fees_amount, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,$5,$6,'supplier_openings',$7,'إلغاء رصيد افتتاحي',$8)`,
        [req.auth.branchId, o.supplier_id, day?.id || null, o.side === "owed" ? "decrease" : "increase",
         o.kind === "gold" ? o.fine_weight : 0, o.kind === "cash" ? o.amount : 0, o.id, req.auth.userId]
      );
      const { rows: up } = await client.query(
        "update supplier_openings set voided_at = now(), voided_by = $2, void_entry_id = $3 where id = $1 returning *",
        [o.id, req.auth.userId, entryId]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details) values ($1,'void',$2,'supplier_openings',$3,'{}')`,
        [req.auth.branchId, req.auth.userId, o.id]
      );
      return { opening: shape(up[0]) };
    });
    if (result.error) return res.status(result.error === "opening_not_found" ? 404 : 409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
