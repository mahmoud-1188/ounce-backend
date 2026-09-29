import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireAnyPage } from "../middleware/auth.js";
import { loadModules, modOn } from "../domain/modules.js";
import { einvoiceXml, issueEInvoices, sellerInfo, verifyChain } from "../domain/einvoice.js";

const router = Router();
const gate = [authenticate, requireAnyPage("einvoice", "vatReturn", "taxReport")];

const row = (e) => ({
  id: e.id, icv: e.icv, type: e.type, ref: e.ref, refTable: e.ref_table, refId: e.ref_id, uuid: e.uuid,
  pih: e.pih, hash: e.hash, qr: e.qr, total: Number(e.total), vat: Number(e.vat), docDate: e.doc_date, issuedAt: e.issued_at,
});

/**
 * GET /api/einvoices — السلسلة (آخر 300) بعد إصدار ما فات منها (تعثّر إصدارٍ وقت البيع يُلتقط هنا).
 * يعيد حال الوحدة وهل الرقم الضريبي مضبوط.
 */
router.get("/einvoices", ...gate, async (req, res, next) => {
  try {
    const out = await withBranch(req.auth.branchId, async (client) => {
      const on = modOn(await loadModules(client, req.auth.branchId), "zatca");
      if (on) await issueEInvoices(client, req.auth.branchId);
      const { rows: br } = await client.query("select name, profile from branches where id = $1", [req.auth.branchId]);
      const info = sellerInfo(br[0]);
      const { rows } = await client.query(
        "select * from einvoices where branch_id = $1 order by icv desc limit 300", [req.auth.branchId]);
      const { rows: cnt } = await client.query("select count(*)::int as n from einvoices where branch_id = $1", [req.auth.branchId]);
      return { on, vatSet: /^\d{15}$/.test(info.vat), info, count: cnt[0].n, einvoices: rows.map(row) };
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

/** GET /api/einvoices/of/:refTable/:refId — مستند فاتورةٍ أو مرتجعٍ بعينه (لرمز QR على الفاتورة المطبوعة). */
router.get("/einvoices/of/:refTable/:refId", authenticate, async (req, res, next) => {
  if (!["sales", "returns"].includes(req.params.refTable)) return res.status(400).json({ error: "invalid_ref_table" });
  try {
    const e = await withBranch(req.auth.branchId, async (client) => (await client.query(
      "select * from einvoices where branch_id = $1 and ref_table = $2 and ref_id = $3", [req.auth.branchId, req.params.refTable, req.params.refId])).rows[0]);
    if (!e) return res.status(404).json({ error: "not_found" });
    res.json({ einvoice: row(e) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/einvoices/verify — العدّاد بلا فجوة، وكل PIH تجزئة سابقه، وكل تجزئةٍ تطابق محتوى مستندها اليوم. */
router.get("/einvoices/verify", ...gate, async (req, res, next) => {
  try {
    res.json(await withBranch(req.auth.branchId, (client) => verifyChain(client, req.auth.branchId)));
  } catch (err) {
    next(err);
  }
});

/** GET /api/einvoices/:id/xml — ملف UBL الكامل كما صدر (مع رمز QR). */
router.get("/einvoices/:id/xml", ...gate, async (req, res, next) => {
  try {
    const xml = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query("select * from einvoices where id = $1 and branch_id = $2", [req.params.id, req.auth.branchId]);
      return rows[0] ? einvoiceXml(client, rows[0]) : null;
    });
    if (!xml) return res.status(404).json({ error: "not_found" });
    res.setHeader("content-type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch (err) {
    next(err);
  }
});

export default router;
