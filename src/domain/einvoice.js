import crypto from "node:crypto";
import { loadModules, modOn } from "./modules.js";

/**
 * الفوترة الإلكترونية (المرجع 5.2.0: buildZatcaXml · zatcaDocOf · issueEInvoice · verifyEInvoiceChain).
 *
 * ملف UBL 2.1 للفاتورة المبسّطة (388) أو إشعار الدائن (381)، بعدّادٍ متسلسل وتجزئة السابق.
 * ⚠ على الخادم لا في المتصفح: عدّة أجهزة تبيع في الفرع نفسه — عدّادٌ في كل جهاز يفرّع السلسلة.
 * التوقيع والإبلاغ للهيئة يحتاجان شهادة الجهاز (CSID) عبر مزوّد حلولٍ معتمد يستلم هذه الملفات.
 */
const ZATCA_PIH0 = "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";
// الذهب الاستثماري خاضعٌ للنسبة الصفرية (المادة 36 من اللائحة التنفيذية)
const ZATCA_Z_REASON = { 36: ["VATEX-SA-36", "Qualifying metals"] };

const toH = (x) => Math.round((Number(x) || 0) * 100);
const m = (h) => (h / 100).toFixed(2);
const xmlEsc = (v) => String(v ?? "").split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;").split('"').join("&quot;");
const sha256b64 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("base64");

function zatcaTlv(fields) {
  const parts = [];
  for (const [tag, val] of fields) {
    const b = Buffer.from(String(val ?? ""), "utf8");
    parts.push(Buffer.from([tag, b.length]), b);
  }
  return Buffer.concat(parts).toString("base64");
}

/** بيانات البائع من هوية الفرع (branches.profile) — تُحفظ مع المستند كما كانت لحظة إصداره. */
function sellerInfo(branch) {
  const p = branch?.profile || {};
  return {
    name: String(p.storeName || branch?.name || "").trim(), legalName: String(p.legalName || "").trim(),
    vat: String(p.vatNumber || "").trim(), cr: String(p.crNumber || "").trim(),
    address: String(p.address || "").trim(), city: String(p.city || "").trim(),
  };
}

/** المستند الموحّد من الفاتورة وأسطرها، أو من المرتجع وأسطر فاتورته. */
function docOf(type, rec, sale, saleLines) {
  const rate = Number(sale.tax_rate) || 0;
  const taxable = !!sale.tax_applicable;
  const lines = type === "381"
    ? (rec.line_indexes || []).map((i) => saleLines[i]).filter(Boolean)
    : saleLines;
  return {
    type, ref: rec.ref, date: type === "381" ? rec.created_at : sale.date,
    billingRef: type === "381" ? sale.ref : null,
    reason: type === "381" ? (rec.reason || "مرتجع") : null,
    customerName: sale.customer_name || "",
    payment: sale.payment_method === "card" ? "48" : sale.payment_method === "credit" ? "30" : "10",
    lines: lines.map((l, i) => {
      const gross = toH(Number(l.unit_price) * (Number(l.quantity) || 1));
      const net = taxable ? Math.round(gross / (1 + rate)) : gross;
      return {
        n: i + 1, name: l.part_label || `${l.category_name || "قطعة"} ع${l.karat || ""}`,
        qty: l.part_label ? 1 : Number(l.quantity) || 1, net, tax: gross - net, gross, exempt: !taxable, rate: taxable ? rate : 0,
      };
    }),
  };
}

function buildZatcaXml(doc, { info = {}, uuid, icv, pih, qr = "", forHash = false } = {}) {
  const net = doc.lines.reduce((a, l) => a + l.net, 0), tax = doc.lines.reduce((a, l) => a + l.tax, 0);
  const d = new Date(doc.date);
  const date = d.toISOString().slice(0, 10), time = d.toISOString().slice(11, 19);
  const groups = {};
  doc.lines.forEach((l) => { const k = l.exempt ? "O" : "S"; const g = groups[k] || (groups[k] = { net: 0, tax: 0, rate: l.rate }); g.net += l.net; g.tax += l.tax; });
  const catXml = (k, rate) => `<cac:TaxCategory><cbc:ID>${k}</cbc:ID><cbc:Percent>${(rate * 100).toFixed(2)}</cbc:Percent>${k === "O" ? "<cbc:TaxExemptionReasonCode>VATEX-SA-OOS</cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>Not subject to VAT</cbc:TaxExemptionReason>" : ""}<cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:ProfileID>reporting:1.0</cbc:ProfileID>
<cbc:ID>${xmlEsc(doc.ref)}</cbc:ID>
<cbc:UUID>${xmlEsc(uuid)}</cbc:UUID>
<cbc:IssueDate>${date}</cbc:IssueDate>
<cbc:IssueTime>${time}</cbc:IssueTime>
<cbc:InvoiceTypeCode name="0200000">${doc.type}</cbc:InvoiceTypeCode>
<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
<cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>${doc.billingRef ? `
<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xmlEsc(doc.billingRef)}</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>` : ""}
<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${icv}</cbc:UUID></cac:AdditionalDocumentReference>
<cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${xmlEsc(pih)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>${forHash ? "" : `
<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${xmlEsc(qr)}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`}
<cac:AccountingSupplierParty><cac:Party>${info.cr ? `<cac:PartyIdentification><cbc:ID schemeID="CRN">${xmlEsc(info.cr)}</cbc:ID></cac:PartyIdentification>` : ""}<cac:PostalAddress><cbc:StreetName>${xmlEsc(info.address || "-")}</cbc:StreetName><cbc:CityName>${xmlEsc(info.city || "-")}</cbc:CityName><cac:Country><cbc:IdentificationCode>SA</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>${xmlEsc(info.vat || "")}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(info.legalName || info.name || "")}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(doc.customerName || "عميل نقدي")}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>${doc.payment}</cbc:PaymentMeansCode>${doc.reason ? `<cbc:InstructionNote>${xmlEsc(doc.reason)}</cbc:InstructionNote>` : ""}</cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${m(tax)}</cbc:TaxAmount></cac:TaxTotal>
<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${m(tax)}</cbc:TaxAmount>${Object.entries(groups).map(([k, g]) => `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="SAR">${m(g.net)}</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">${m(g.tax)}</cbc:TaxAmount>${catXml(k, g.rate)}</cac:TaxSubtotal>`).join("")}</cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="SAR">${m(net)}</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="SAR">${m(net)}</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SAR">${m(net + tax)}</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="SAR">${m(net + tax)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
${doc.lines.map((l) => `<cac:InvoiceLine><cbc:ID>${l.n}</cbc:ID><cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">${m(l.net)}</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${m(l.tax)}</cbc:TaxAmount><cbc:RoundingAmount currencyID="SAR">${m(l.gross)}</cbc:RoundingAmount></cac:TaxTotal><cac:Item><cbc:Name>${xmlEsc(l.name)}</cbc:Name><cac:ClassifiedTaxCategory><cbc:ID>${l.exempt ? "O" : "S"}</cbc:ID><cbc:Percent>${(l.rate * 100).toFixed(2)}</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="SAR">${m(Math.round(l.net / l.qty))}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join("\n")}
</Invoice>`;
}

async function loadSaleLines(client, saleId) {
  const { rows } = await client.query(
    `select sl.*, c.name as category_name from sale_lines sl left join categories c on c.id::text = sl.category
      where sl.sale_id = $1 order by sl.line_no`, [saleId]);
  return rows;
}

/** المستند وفاتورته وأسطرها من سجلّ السلسلة — لإعادة البناء (XML · الفحص). */
async function sourceOf(client, e) {
  if (e.ref_table === "returns") {
    const { rows: r } = await client.query("select * from returns where id = $1", [e.ref_id]);
    if (!r[0]) return null;
    const { rows: s } = await client.query("select * from sales where id = $1", [r[0].sale_id]);
    if (!s[0]) return null;
    return { rec: r[0], sale: s[0], lines: await loadSaleLines(client, s[0].id) };
  }
  const { rows: s } = await client.query("select * from sales where id = $1", [e.ref_id]);
  if (!s[0]) return null;
  return { rec: s[0], sale: s[0], lines: await loadSaleLines(client, s[0].id) };
}

/**
 * يُصدر ما لم يُصدَر بعد من فواتير الفرع ومرتجعاته — بترتيب تاريخها، بقفلٍ على الفرع
 * فلا يأخذ مستندان العدّاد نفسه. مطفأة الوحدة: لا شيء. يُنادى داخل معاملة البيع/المرتجع.
 */
async function issueEInvoices(client, branchId) {
  if (!modOn(await loadModules(client, branchId), "zatca")) return [];
  await client.query("select pg_advisory_xact_lock(hashtext('einvoice:' || $1::text))", [branchId]);
  const { rows: st } = await client.query(
    `update branch_settings set einvoice_since = coalesce(einvoice_since, now()) where branch_id = $1 returning einvoice_since`, [branchId]);
  const since = st[0]?.einvoice_since;
  if (!since) return [];
  const { rows: pending } = await client.query(
    `select 'sales' as ref_table, s.id as ref_id, s.date as at from sales s
      where s.branch_id = $1 and s.date >= $2
        and not exists (select 1 from einvoices e where e.branch_id = $1 and e.ref_table = 'sales' and e.ref_id = s.id)
     union all
     select 'returns', r.id, r.created_at from returns r
      where r.branch_id = $1 and r.created_at >= $2
        and not exists (select 1 from einvoices e where e.branch_id = $1 and e.ref_table = 'returns' and e.ref_id = r.id)
     order by at, ref_id`, [branchId, since]);
  if (!pending.length) return [];
  const { rows: br } = await client.query("select name, profile from branches where id = $1", [branchId]);
  const info = sellerInfo(br[0]);
  const { rows: last } = await client.query("select icv, hash from einvoices where branch_id = $1 order by icv desc limit 1", [branchId]);
  let prev = last[0] || null;
  const issued = [];
  for (const p of pending) {
    const src = await sourceOf(client, p);
    if (!src) continue;
    const type = p.ref_table === "returns" ? "381" : "388";
    const doc = docOf(type, src.rec, src.sale, src.lines);
    const icv = (prev?.icv || 0) + 1;
    const pih = prev?.hash || ZATCA_PIH0;
    const uuid = crypto.randomUUID();
    const hash = sha256b64(buildZatcaXml(doc, { info, uuid, icv, pih, forHash: true }));
    const totalH = doc.lines.reduce((a, l) => a + l.gross, 0), vatH = doc.lines.reduce((a, l) => a + l.tax, 0);
    const qr = zatcaTlv([[1, info.legalName || info.name], [2, info.vat], [3, new Date(doc.date).toISOString().slice(0, 19) + "Z"],
      [4, m(totalH)], [5, m(vatH)], [6, hash]]);
    const { rows } = await client.query(
      `insert into einvoices (branch_id, icv, type, ref_table, ref_id, ref, uuid, pih, hash, qr, total, vat, doc_date, info)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [branchId, icv, type, p.ref_table, p.ref_id, doc.ref, uuid, pih, hash, qr, totalH / 100, vatH / 100, doc.date, JSON.stringify(info)]);
    prev = rows[0];
    issued.push(rows[0]);
  }
  return issued;
}

/**
 * يُصدر بعد فعل البيع/المرتجع بنقطة حفظ: تعثّر الإصدار لا يُسقط البيع — يبقى المستند
 * بلا رقم في السلسلة ويُلتقط في الإصدار التالي (أو بفتح شاشة الفوترة).
 */
async function issueEInvoicesSafe(client, branchId) {
  await client.query("savepoint einvoice_issue");
  try {
    const out = await issueEInvoices(client, branchId);
    await client.query("release savepoint einvoice_issue");
    return out;
  } catch (err) {
    await client.query("rollback to savepoint einvoice_issue");
    console.error("einvoice issue failed:", err.message);
    return [];
  }
}

/** ملف XML الكامل لمستندٍ صدر — ببيانات البائع والتجزئة كما صدر بها. */
async function einvoiceXml(client, e) {
  const src = await sourceOf(client, e);
  if (!src) return null;
  return buildZatcaXml(docOf(e.type, src.rec, src.sale, src.lines), { info: e.info || {}, uuid: e.uuid, icv: e.icv, pih: e.pih, qr: e.qr });
}

/** فحص السلسلة: العدّاد بلا فجوة، وPIH تجزئة سابقه، وتجزئة كل مستندٍ تطابق محتواه اليوم. */
async function verifyChain(client, branchId) {
  const { rows } = await client.query("select * from einvoices where branch_id = $1 order by icv", [branchId]);
  const issues = [];
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i], prev = rows[i - 1];
    if (e.icv !== (prev ? prev.icv + 1 : 1)) issues.push({ ref: e.ref, why: `فجوة في العدّاد عند ${e.icv}` });
    if (e.pih !== (prev ? prev.hash : ZATCA_PIH0)) issues.push({ ref: e.ref, why: "تجزئة السابق لا تطابق" });
    const src = await sourceOf(client, e);
    if (!src) { issues.push({ ref: e.ref, why: "المستند الأصلي غير موجود" }); continue; }
    const h = sha256b64(buildZatcaXml(docOf(e.type, src.rec, src.sale, src.lines), { info: e.info || {}, uuid: e.uuid, icv: e.icv, pih: e.pih, forHash: true }));
    if (h !== e.hash) issues.push({ ref: e.ref, why: "محتوى المستند تغيّر بعد إصداره" });
  }
  return { ok: issues.length === 0, issues, count: rows.length };
}

export { ZATCA_PIH0, buildZatcaXml, einvoiceXml, issueEInvoices, issueEInvoicesSafe, sellerInfo, verifyChain, zatcaTlv };
