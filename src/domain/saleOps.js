import { roundMoney, toHalalas, fromHalalas } from "./money.js";
import { fineWeight } from "./weight.js";

/**
 * أجزاء البيع والمرتجع المشتركة — يستعملها POST /sales وPOST
 * /sales/:id/return-full وPOST /sales/:id/exchange معًا، فلا تتباعد
 * قواعد حجز القطع أو حساب المرتجع بين المسارات الثلاثة.
 *
 * كل دالة هنا تعمل داخل معاملة withBranch قائمة (client) ولا تفتح معاملة.
 * الأخطاء المتوقَّعة تُعاد كائنًا { error, ... } لا استثناءً، بنفس نمط
 * المسارات الحالية.
 */

async function nextRef(client, table, branchId, prefix) {
  const { rows } = await client.query(
    `select count(*)::int + 1 as n from ${table} where branch_id = $1`,
    [branchId]
  );
  return `${prefix}-${String(rows[0].n).padStart(6, "0")}`;
}

async function isStocktakeLocked(client, branchId) {
  const { rows } = await client.query("select locked from stocktake_locks where branch_id = $1", [branchId]);
  return !!rows[0]?.locked;
}

async function getOpenBusinessDay(client, branchId) {
  const { rows } = await client.query(
    `select id, ref from business_days
      where branch_id = $1 and status = 'open'
      order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0] || null;
}

/**
 * يقفل الأصناف ويعلّم N وحدة غير مباعة وغير مُخرَجة مباعةً لكل سطر.
 * excludeUnitIds: وحدات لا تُختار (في الاستبدال: القطع العائدة للتوّ،
 * فلا تُباع القطعة نفسها مرةً ثانية في المعاملة ذاتها).
 */
async function reserveSaleLines(client, branchId, lines, { excludeUnitIds = [] } = {}) {
  const resolvedLines = [];
  let subtotal = 0;
  const weightByKarat = new Map();

  for (const line of lines) {
    const { rows: itemRows } = await client.query(
      `select i.*, c.sale_mode
         from items i join categories c on c.id = i.category_id
        where i.id = $1 and i.branch_id = $2
        for update of i`,
      [line.itemId, branchId]
    );
    const item = itemRows[0];
    if (!item) return { error: "item_not_found", itemId: line.itemId };
    if (item.sale_mode === "partial") {
      return { error: "item_requires_partial_sale_endpoint", itemId: line.itemId };
    }

    // ⚠ issued=false: قطعة أُخرجت (تالفة/فاقد) لا تُباع وإن بقيت sold=false.
    const { rows: unsoldRows } = await client.query(
      `select id from item_units
        where item_id = $1 and sold = false and issued = false
          and not (id = any($3::uuid[]))
        order by code limit $2`,
      [item.id, line.quantity, excludeUnitIds]
    );
    if (unsoldRows.length < line.quantity) {
      return {
        error: "insufficient_stock",
        itemId: line.itemId,
        available: unsoldRows.length,
        requested: line.quantity,
      };
    }
    await client.query(`update item_units set sold = true where id = any($1::uuid[])`, [unsoldRows.map((r) => r.id)]);

    subtotal += Number(line.unitPrice) * Number(line.quantity);
    const lineWeight = Number(item.weight) * Number(line.quantity);
    weightByKarat.set(item.karat, (weightByKarat.get(item.karat) || 0) + lineWeight);

    resolvedLines.push({
      itemId: item.id,
      category: item.category_id,
      karat: item.karat,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      weightSnapshot: item.weight,
      costPerGramSnapshot: item.cost_per_gram,
      workmanshipSnapshot: item.workmanship,
    });
  }
  return { resolvedLines, subtotal, weightByKarat };
}

// ⚠ line_no صريح (migration 013): الفهرس عند الإرجاع يطابق ترتيب الشاشة.
async function insertSaleLines(client, saleId, resolvedLines) {
  for (let i = 0; i < resolvedLines.length; i++) {
    const l = resolvedLines[i];
    await client.query(
      `insert into sale_lines
         (sale_id, item_id, category, karat, quantity, unit_price,
          weight_snapshot, cost_per_gram_snapshot, workmanship_snapshot, line_no)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [saleId, l.itemId, l.category, l.karat, l.quantity, l.unitPrice,
        l.weightSnapshot, l.costPerGramSnapshot, l.workmanshipSnapshot, i]
    );
  }
}

/** دفتر الوزن: الذهب يخرج من 1210 (بيع) أو يعود إليه (مرتجع). */
async function postGoldMovement(client, { branchId, businessDayId, opType, weightByKarat, refTable, refId, note, createdBy }) {
  const out = opType === "sale";
  for (const [karat, weight] of weightByKarat) {
    await client.query(
      `insert into gold_ledger_entries
         (branch_id, business_day_id, op_type, karat, weight, fine_weight,
          from_account, to_account, ref_table, ref_id, note, created_by)
       values ($1,$2,$3,$4,$5,$6, $7,$8, $9,$10,$11,$12)`,
      [branchId, businessDayId, opType, karat, weight, fineWeight(weight, karat),
        out ? "1210" : null, out ? null : "1210", refTable, refId, note, createdBy]
    );
  }
}

/**
 * يقفل الفاتورة ويقرأ أسطرها ويتحقق من فهارس المرتجع ومن عدم إرجاع سطرٍ
 * مرّتين.
 */
async function loadSaleForReturn(client, branchId, saleId, lineIndexes) {
  const { rows: saleRows } = await client.query(
    "select * from sales where id = $1 and branch_id = $2 for update",
    [saleId, branchId]
  );
  const sale = saleRows[0];
  if (!sale) return { error: "sale_not_found" };

  const { rows: allLines } = await client.query(
    `select * from sale_lines where sale_id = $1 order by line_no`,
    [sale.id]
  );
  for (const i of lineIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= allLines.length) return { error: "line_index_out_of_range", index: i };
  }
  if (new Set(lineIndexes).size !== lineIndexes.length) return { error: "duplicate_line_index" };

  const { rows: priorReturns } = await client.query(
    `select line_indexes from returns where sale_id = $1 and branch_id = $2`,
    [sale.id, branchId]
  );
  const alreadyReturned = new Set();
  for (const r of priorReturns) for (const i of r.line_indexes || []) alreadyReturned.add(i);
  const dup = lineIndexes.find((i) => alreadyReturned.has(i));
  if (dup != null) return { error: "line_already_returned", index: dup };

  return { sale, allLines, returnedLines: lineIndexes.map((i) => allLines[i]) };
}

/**
 * قيمة المرتجع بأسعار الفاتورة الأصل.
 *
 * ⚠ سعر السطر شاملٌ للضريبة (مجموع الأسطر = إجمالي الفاتورة، والضريبة
 * مستخرجة منه في POST /sales). فالمرتجع يُردّ بقيمة أسطره كما دُفعت،
 * والضريبة جزءٌ منها بنسبة الفاتورة الفعلية — لا تُضاف فوقها. الحساب
 * السابق كان يضيفها فوق السعر الشامل فيردّ للعميل أكثر مما دفع.
 */
function computeReturnAmounts(sale, allLines, returnedLines) {
  const lineH = (l) => toHalalas(Number(l.unit_price) * Number(l.quantity));
  const grossH = returnedLines.reduce((a, l) => a + lineH(l), 0);
  const saleLinesH = allLines.reduce((a, l) => a + lineH(l), 0);
  const saleTaxH = toHalalas(sale.tax_amount || 0);
  const taxH = saleLinesH > 0 ? Math.round((grossH * saleTaxH) / saleLinesH) : 0;

  // التكلفة للعرض والسجل فقط — لا تُرحَّل: النظام دوري (البيع لا يقيّد
  // تكلفة)، و1200/5100 حسابا مجموعة.
  const cost = roundMoney(returnedLines.reduce((a, l) => {
    const perUnit = (Number(l.cost_per_gram_snapshot) || 0) * (Number(l.weight_snapshot) || 0)
      + (Number(l.workmanship_snapshot) || 0);
    return a + perUnit * Number(l.quantity);
  }, 0));

  const weightByKarat = new Map();
  for (const l of returnedLines) {
    const w = Number(l.weight_snapshot) * Number(l.quantity);
    weightByKarat.set(l.karat, (weightByKarat.get(l.karat) || 0) + w);
  }
  const totalWeight = [...weightByKarat.values()].reduce((a, w) => a + w, 0);

  return {
    gross: fromHalalas(grossH),
    tax: fromHalalas(taxH),
    net: fromHalalas(grossH - taxH),
    cost,
    weightByKarat,
    totalWeight,
  };
}

/**
 * يعيد N وحدة مباعة من صنف كل سطر (لا ربط مخزَّن بين السطر ووحدةٍ
 * بعينها). التالفة تعود issued=true فلا تُباع حتى تُفحص.
 */
async function restockReturnedLines(client, returnedLines, restock) {
  const unitIds = [];
  for (const l of returnedLines) {
    // ⚠ sale_lines.quantity من نوع numeric(12,3) فيصل نصًّا "1.000" —
    // وLIMIT يرفضه (22P02) فكان كل مرتجع يفشل بخطأ خادم. عددٌ صحيح هنا.
    const qty = Math.round(Number(l.quantity) || 0);
    const { rows: soldUnits } = await client.query(
      `select id from item_units where item_id = $1 and sold = true order by code limit $2`,
      [l.item_id, qty]
    );
    if (soldUnits.length < qty) {
      return { error: "unit_mismatch", itemId: l.item_id, available: soldUnits.length, requested: qty };
    }
    const ids = soldUnits.map((r) => r.id);
    if (restock === "damaged") {
      await client.query(`update item_units set sold = false, issued = true where id = any($1::uuid[])`, [ids]);
    } else {
      await client.query(`update item_units set sold = false where id = any($1::uuid[])`, [ids]);
    }
    unitIds.push(...ids);
  }
  return { unitIds };
}

/** سطر نقد مباشر بلا قيد — القيد يكتبه المستند نفسه. */
async function insertCashTx(client, { branchId, businessDayId, pool, method, direction, amount, category, refTable, refId, note, createdBy }) {
  const { rows } = await client.query(
    `insert into cash_tx
       (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [branchId, businessDayId, pool, method, direction, roundMoney(amount), category, refTable, refId, note, createdBy]
  );
  return rows[0];
}

async function insertReturnReceipt(client, { branchId, sale, amount, note, businessDayId, createdBy }) {
  const receiptRef = await nextRef(client, "receipts", branchId, "RCP");
  const { rows } = await client.query(
    `insert into receipts
       (branch_id, ref, customer_id, customer_name, sale_id, amount, method, category, note, business_day_id, created_by)
     values ($1,$2,$3,$4,$5,$6,'adjust','sales_return',$7,$8,$9)
     returning *`,
    [branchId, receiptRef, sale.customer_id, sale.customer_name, sale.id, amount, note, businessDayId, createdBy]
  );
  return rows[0];
}

export {
  nextRef,
  isStocktakeLocked,
  getOpenBusinessDay,
  reserveSaleLines,
  insertSaleLines,
  postGoldMovement,
  loadSaleForReturn,
  computeReturnAmounts,
  restockReturnedLines,
  insertCashTx,
  insertReturnReceipt,
};
