import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { loadModules, modCfg, modOn } from "../domain/modules.js";

const router = Router();

/**
 * العملاء (migration 055) — كانوا يُضافون في المتصفح وحده فلا تعرفهم الفاتورة على الخادم.
 *   POST  /customers { name, phone, idNumber, note }
 *   PATCH /customers/:id { name?, phone?, idNumber?, note? }
 *   GET   /aml/register?from&to — العمليات النقدية التي بلغت حدّ الهوية (وحدة aml)
 */
const guard = [authenticate, requireAnyPage("customers", "sales")];
const validIdNumber = (v) => /^[12]\d{9}$/.test(String(v || "").trim()) || /^(?=.*[A-Z])[A-Z0-9]{6,12}$/i.test(String(v || "").trim());
const shape = (c) => ({ id: c.id, ref: c.ref, name: c.name, phone: c.phone || "", idNumber: c.id_number || "", note: c.note || "", createdAt: c.created_at });

router.post("/customers", ...guard, async (req, res, next) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 120);
  const idNumber = String(b.idNumber || "").trim().toUpperCase();
  if (!name) return res.status(400).json({ error: "name_required" });
  if (idNumber && !validIdNumber(idNumber)) return res.status(400).json({ error: "invalid_id_number" });
  try {
    const result = await withBranch(req.auth.branchId, async (c) => {
      const { rows: dup } = await c.query("select 1 from customers where branch_id = $1 and lower(trim(name)) = lower($2)", [req.auth.branchId, name]);
      if (dup[0]) return { error: "customer_name_exists" };
      const { rows: n } = await c.query("select count(*)::int + 1 as n from customers where branch_id = $1", [req.auth.branchId]);
      const { rows } = await c.query(
        "insert into customers (branch_id, ref, name, phone, id_number, note, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning *",
        [req.auth.branchId, `CUS-${String(n[0].n).padStart(6, "0")}-${Date.now().toString(36).slice(-3).toUpperCase()}`, name,
         String(b.phone || "").trim().slice(0, 30) || null, idNumber || null, String(b.note || "").trim().slice(0, 200) || null, req.auth.userId]);
      return { customer: shape(rows[0]) };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.patch("/customers/:id", ...guard, async (req, res, next) => {
  const b = req.body || {};
  const idNumber = b.idNumber == null ? null : String(b.idNumber).trim().toUpperCase();
  if (idNumber && !validIdNumber(idNumber)) return res.status(400).json({ error: "invalid_id_number" });
  try {
    const rows = await withBranch(req.auth.branchId, async (c) => (await c.query(
      `update customers set name = coalesce($3, name), phone = coalesce($4, phone), id_number = coalesce($5, id_number), note = coalesce($6, note)
        where id = $1 and branch_id = $2 returning *`,
      [req.params.id, req.auth.branchId, b.name ? String(b.name).trim().slice(0, 120) : null, b.phone != null ? String(b.phone).trim() : null,
       idNumber, b.note != null ? String(b.note).slice(0, 200) : null])).rows);
    if (!rows[0]) return res.status(404).json({ error: "customer_not_found" });
    res.json({ customer: shape(rows[0]) });
  } catch (err) {
    next(err);
  }
});

router.get("/aml/register", authenticate, requireAnyPage("amlRegister", "customers", "taxReport"), async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (c) => {
      const mods = await loadModules(c, req.auth.branchId);
      const th = Number(modCfg(mods, "aml").cashThreshold) || 0;
      const { rows } = await c.query(
        `select s.id, s.ref, s.date, s.total, s.payment_method, s.cash_part, s.kyc, cu.name as customer, cu.id_number, u.name as seller
           from sales s left join customers cu on cu.id = s.customer_id left join users u on u.id = s.seller_id
          where s.branch_id = $1 and ($2::date is null or s.date >= $2::date) and ($3::date is null or s.date < $3::date + 1)
            and (s.kyc is not null or (case when s.payment_method = 'cash' then s.total when s.payment_method = 'split' then s.cash_part else 0 end) >= $4)
          order by s.date desc limit 500`,
        [req.auth.branchId, req.query.from || null, req.query.to || null, th > 0 ? th : 1e15]);
      return { on: modOn(mods, "aml"), threshold: th, rows: rows.map((r) => ({
        id: r.id, ref: r.ref, date: r.date, total: Number(r.total), cash: r.payment_method === "split" ? Number(r.cash_part) : r.payment_method === "cash" ? Number(r.total) : 0,
        customer: r.kyc?.name || r.customer || "", idNumber: r.kyc?.idNumber || r.id_number || "", seller: r.seller || "", hasKyc: !!r.kyc })) };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

export { validIdNumber };
export default router;
