import { fineWeight, roundWeight } from "./weight.js";
import { roundMoney } from "./money.js";

/**
 * استعلام القطع (المرجع 5.2.0 — buildPieceInquiry): لكل رمزٍ ممسوح أو مكتوب
 * بطاقةٌ كاملة — الصنف والوزن والعيار وبعيار 24، والمورد ودفعة الشراء وفاتورتها،
 * ومن كوّدها، وحالتها الحقيقية (متاحة · مباعة بفاتورتها وعميلها · مُخرَجة بسببها ·
 * محجوزة). قراءةٌ فقط. التكلفة لمن يرى التكاليف وحده.
 */
const ISSUE_LABEL = {
  returned_supplier: "إعادة للمورد", damaged: "تلف", lost: "فقد", gift: "هدية أو عيّنة",
  melted: "تحويل لكسر", branch: "تحويل لفرع آخر", correction: "تصحيح إدخال خاطئ",
};

async function buildPieceInquiry(client, branchId, codes, { showCost = false } = {}) {
  const asked = [...new Set((codes || []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))].slice(0, 100);
  if (!asked.length) return [];
  const { rows } = await client.query(
    `select u.id as unit_id, u.code, u.epc, u.sold, u.issued, u.issued_at, u.printed, u.sale_id,
            i.id as item_id, i.ref as item_ref, i.karat, i.weight, i.stones_weight, i.cost_per_gram, i.workmanship,
            i.from_scrap, i.photo_url, i.date_added, i.reserved_for, i.lot_id,
            c.name as category, cu.name as coded_by,
            (select count(*)::int from item_units x where x.item_id = i.id) as units_total,
            (select count(*)::int from item_units x where x.item_id = i.id and not x.sold and not x.issued) as units_available,
            l.ref as lot_ref, l.date as lot_date, l.karat as lot_karat, l.weight as lot_weight, l.cost_per_gram as lot_cpg, l.source as lot_source,
            p.ref as purchase_ref, p.payment_method as purchase_method, p.invoice_pending,
            s.id as supplier_id, s.name as supplier_name, s.phone as supplier_phone,
            sa.ref as sale_ref, sa.date as sale_date, coalesce(sa.customer_name, cust.name) as sale_customer, sa.seller_name,
            (select sl.unit_price from sale_lines sl where sl.sale_id = sa.id and sl.item_id = i.id order by sl.line_no limit 1) as sale_price,
            gi.ref as issue_ref, gi.reason_id as issue_reason, gi.note as issue_note, gu.name as issued_by,
            r.ref as reservation_ref, rc.name as reservation_customer
       from item_units u
       join items i on i.id = u.item_id
       left join categories c on c.id = i.category_id
       left join users cu on cu.id = i.created_by
       left join lots l on l.id = i.lot_id
       left join purchases p on p.id = l.purchase_id
       left join suppliers s on s.id = coalesce(l.supplier_id, p.supplier_id)
       left join sales sa on sa.id = u.sale_id
       left join customers cust on cust.id = sa.customer_id
       left join gold_issues gi on gi.id = u.issue_id
       left join users gu on gu.id = coalesce(u.issued_by, gi.created_by)
       left join reservations r on r.id = i.reserved_for
       left join customers rc on rc.id = r.customer_id
      where i.branch_id = $1 and (upper(u.code) = any($2::text[]) or upper(u.epc) = any($2::text[]))`,
    [branchId, asked]
  );
  const byKey = new Map();
  for (const r of rows) {
    byKey.set(String(r.code).toUpperCase(), r);
    if (r.epc) byKey.set(String(r.epc).toUpperCase(), r);
  }
  return asked.map((a) => {
    const r = byKey.get(a);
    if (!r) return { asked: a, found: false };
    const weight = Number(r.weight) || 0;
    const status = r.sold ? "sold" : r.issued ? "issued" : r.reserved_for ? "reserved" : "available";
    const cost = roundMoney((Number(r.cost_per_gram) || 0) * weight + (Number(r.workmanship) || 0));
    return {
      asked: a, found: true, code: r.code, itemId: r.item_id, unitId: r.unit_id, status,
      category: r.category || "", ref: r.item_ref, karat: r.karat, weight: roundWeight(weight),
      fine: fineWeight(weight, r.karat), stonesWeight: roundWeight(Number(r.stones_weight) || 0),
      workmanship: roundMoney(r.workmanship), photo: r.photo_url || null,
      ...(showCost ? { costPerGram: Number(r.cost_per_gram) || 0, cost } : {}),
      codedBy: r.coded_by || "", codedAt: r.date_added, fromScrap: !!r.from_scrap, printed: !!r.printed,
      siblings: { total: r.units_total, available: r.units_available },
      lot: r.lot_ref ? { ref: r.lot_ref, date: r.lot_date, karat: r.lot_karat, weight: Number(r.lot_weight) || 0,
        opening: r.lot_source === "opening", purchaseRef: r.purchase_ref || null, paymentMethod: r.purchase_method || null,
        invoicePending: !!r.invoice_pending, ...(showCost ? { costPerGram: Number(r.lot_cpg) || 0 } : {}) } : null,
      supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name, phone: r.supplier_phone || "" } : null,
      sale: r.sold && r.sale_ref ? { ref: r.sale_ref, date: r.sale_date, customer: r.sale_customer || "نقدي",
        seller: r.seller_name || "", price: Number(r.sale_price) || 0 } : null,
      issued: r.issued ? { reason: ISSUE_LABEL[r.issue_reason] || r.issue_reason || "", ref: r.issue_ref || "",
        at: r.issued_at, by: r.issued_by || "", note: r.issue_note || "" } : null,
      reservation: r.reservation_ref ? { ref: r.reservation_ref, customer: r.reservation_customer || "" } : null,
    };
  });
}

export { buildPieceInquiry };
