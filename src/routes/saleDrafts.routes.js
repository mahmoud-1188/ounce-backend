import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";

/**
 * الفواتير المعلّقة وعروض الأسعار (migration 069 ⑧ — المرجع D).
 * المسودّة حمولة نافذة البيع كما هي (الأسطر · العميل · الدفع)، تُستأنف فتُكمل فاتورةً عاديةً
 * بكل رقابتها — المسودّة نفسها لا تحجز قطعةً ولا تكتب قيدًا.
 */
const router = Router();
router.use("/sale-drafts", authenticate, requirePage("sales"));

const shape = (d) => ({
  id: d.id, ref: d.ref, kind: d.kind, customerId: d.customer_id, customerName: d.customer_name || "",
  payload: d.payload, total: Number(d.total) || 0, validUntil: d.valid_until, status: d.status,
  saleId: d.sale_id, note: d.note || "", createdBy: d.created_by, createdByName: d.created_by_name || "",
  createdAt: d.created_at, closedAt: d.closed_at,
});

router.get("/sale-drafts", async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `select d.*, u.name as created_by_name from sale_drafts d left join users u on u.id = d.created_by
        where d.branch_id = $1 and (d.status = 'open' or d.created_at > now() - interval '30 days')
        order by d.created_at desc limit 200`, [req.auth.branchId])).rows);
    res.json({ drafts: rows.map(shape) });
  } catch (err) {
    next(err);
  }
});

router.post("/sale-drafts", async (req, res, next) => {
  const b = req.body || {};
  const kind = b.kind === "quote" ? "quote" : "held";
  if (!b.payload || !Array.isArray(b.payload.lines) || !b.payload.lines.length) return res.status(400).json({ error: "draft_needs_lines" });
  const validUntil = /^\d{4}-\d{2}-\d{2}$/.test(String(b.validUntil || "")) ? b.validUntil : null;
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows: n } = await c.query("select count(*)::int + 1 as n from sale_drafts where branch_id = $1", [req.auth.branchId]);
      const ref = `${kind === "quote" ? "QT" : "HLD"}-${String(n[0].n).padStart(5, "0")}`;
      let customerName = null;
      if (b.payload.customerId) {
        const { rows: cu } = await c.query("select name from customers where id = $1 and branch_id = $2", [b.payload.customerId, req.auth.branchId]);
        customerName = cu[0]?.name || null;
      }
      const { rows } = await c.query(
        `insert into sale_drafts (branch_id, ref, kind, customer_id, customer_name, payload, total, valid_until, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [req.auth.branchId, ref, kind, b.payload.customerId || null, customerName, JSON.stringify(b.payload),
          roundMoney(b.total), validUntil, b.note ? String(b.note).slice(0, 200) : null, req.auth.userId]);
      return { draft: shape({ ...rows[0], created_by_name: req.auth.user?.name || "" }) };
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

/** إغلاق المسودّة: done بعد إتمامها فاتورة (saleId)، أو cancelled. */
router.post("/sale-drafts/:id/:action(done|cancel)", async (req, res, next) => {
  const done = req.params.action === "done";
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const { rows } = await c.query(
        `update sale_drafts set status = $3, sale_id = coalesce($4, sale_id), closed_at = now()
          where id = $1 and branch_id = $2 and status = 'open' returning *`,
        [req.params.id, req.auth.branchId, done ? "done" : "cancelled", done ? req.body?.saleId || null : null]);
      if (!rows[0]) return { error: "draft_not_open" };
      return { draft: shape(rows[0]) };
    });
    if (out.error) return res.status(409).json(out);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export default router;
