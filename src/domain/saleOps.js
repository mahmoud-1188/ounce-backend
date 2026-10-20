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

/// البيع أثناء الجرد إعدادٌ (sale_prefs.sellDuringStocktake — migration 069): مفعّلًا يُسمح بالبيع والقفل قائم،
///   وما بِيع منذ بدء القفل يُطابَق مبيعًا عند تطبيق الجرد (لا يُحسب زيادة).
async function saleBlockedByStocktake(client, branchId) {
  const { rows } = await client.query(
    `select l.locked, coalesce((s.sale_prefs->>'sellDuringStocktake')::boolean, false) as sell
       from stocktake_locks l left join branch_settings s on s.branch_id = l.branch_id
      where l.branch_id = $1`, [branchId]);
  return !!rows[0]?.locked && !rows[0]?.sell;
}

/**
 * يوم العمل للحركات التي تحتاجه (بيع، استبدال…).
 * يومٌ مفتوح ⇐ يُختم به. لا يوم والوضع 'off' ⇐ { day: null } وتمرّ الحركة
 * بلا يوم (migration 034). لا يوم والوضع 'required' ⇐ رفض.
 */
async function requireBusinessDay(client, branchId) {
  const day = await getOpenBusinessDay(client, branchId);
  if (day) return { day };
  const { rows } = await client.query("select workday_mode from branch_settings where branch_id = $1", [branchId]);
  if (rows[0]?.workday_mode === "off") return { day: null };
  return { error: "no_open_business_day" };
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
  // حجوزات القطع المباعة بعينها — البيع يتحقق أنها لصاحبها ويخصم عربونها
  const unitReservations = new Set();

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
    // ⚠ بقايا طقمٍ بِيع جزءٌ منه لا تُباع طقمًا كاملًا حتى تُكوَّد قطعًا (migration 066)
    if (item.remnant) return { error: "item_is_set_remnant", itemId: line.itemId };
    // ما كوّدته الإدارة يبقى عندها حتى تراجعه وترسله — لا يُباع في الفرع قبل وصوله
    if (item.lot_id) {
      const { rows: lr } = await client.query("select coding_at from lots where id = $1", [item.lot_id]);
      if (lr[0]?.coding_at === "hq") return { error: "item_at_hq", itemId: line.itemId };
    }

    // ⚠ issued=false: قطعة أُخرجت (تالفة/فاقد) لا تُباع وإن بقيت sold=false.
    // القطع الممسوحة نفسها تُباع (unitCodes)، وإلا أوّل المتاح من الصنف
    const codes = Array.isArray(line.unitCodes) ? [...new Set(line.unitCodes.map((c) => String(c || "").trim()).filter(Boolean))] : [];
    if (codes.length && codes.length !== Number(line.quantity)) {
      return { error: "unit_codes_mismatch", itemId: line.itemId, requested: line.quantity, codes: codes.length };
    }
    const { rows: unsoldRows } = codes.length
      ? await client.query(
        `select id, reserved_for from item_units
          where item_id = $1 and sold = false and issued = false
            and upper(code) = any($2::text[])
            and not (id = any($3::uuid[]))`,
        [item.id, codes.map((c) => c.toUpperCase()), excludeUnitIds]
      )
      : await client.query(
        // القطعة المحجوزة بعينها لا تُختار تلقائيًّا — تُباع لصاحب حجزها بمسح رمزها (migration 088)
        `select id from item_units
          where item_id = $1 and sold = false and issued = false and reserved_for is null
            and not (id = any($3::uuid[]))
          order by held desc, code limit $2`,
        [item.id, line.quantity, excludeUnitIds]
      );
    if (codes.length && unsoldRows.length < codes.length) {
      return { error: "unit_not_available", itemId: line.itemId, requested: codes.length, available: unsoldRows.length };
    }
    if (unsoldRows.length < line.quantity) {
      return {
        error: "insufficient_stock",
        itemId: line.itemId,
        available: unsoldRows.length,
        requested: line.quantity,
      };
    }
    // القطعة المعلّقة من الوضع الخفي تُباع أولًا — البيع يُكمِلها (migration 047)، ويبقى أثرها (held_ref)
    await client.query(`update item_units set sold = true, held = false where id = any($1::uuid[])`, [unsoldRows.map((r) => r.id)]);
    unsoldRows.forEach((r) => { if (r.reserved_for) unitReservations.add(r.reserved_for); });

    subtotal += Number(line.unitPrice) * Number(line.quantity);
    const lineWeight = Number(item.weight) * Number(line.quantity);
    weightByKarat.set(item.karat, (weightByKarat.get(item.karat) || 0) + lineWeight);

    resolvedLines.push({
      itemId: item.id,
      ref: item.ref,
      category: item.category_id,
      karat: item.karat,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      weightSnapshot: item.weight,
      costPerGramSnapshot: item.cost_per_gram,
      workmanshipSnapshot: item.workmanship,
      unitIds: unsoldRows.map((r) => r.id),
    });
  }
  return { resolvedLines, subtotal, weightByKarat, unitReservations: [...unitReservations] };
}

// ⚠ line_no صريح (migration 013): الفهرس عند الإرجاع يطابق ترتيب الشاشة.
async function insertSaleLines(client, saleId, resolvedLines) {
  for (let i = 0; i < resolvedLines.length; i++) {
    const l = resolvedLines[i];
    // الوحدة تحمل فاتورتها (migration 045) — لاستعلام القطع والمرتجع بالوحدة نفسها
    if (l.unitIds?.length) {
      await client.query("update item_units set sale_id = $1 where id = any($2::uuid[])", [saleId, l.unitIds]);
    }
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
async function loadSaleForReturn(client, branchId, saleId, lineIndexes, lineParts = null) {
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

  // ما أُرجع سلفًا من كل سطر بالعدد ورموز قطعه — من أسطر المرتجعات المحفوظة (lines بترتيب line_indexes)
  const { rows: priorReturns } = await client.query(
    `select line_indexes, lines from returns where sale_id = $1 and branch_id = $2`,
    [sale.id, branchId]
  );
  const qtyOf = (l) => Math.max(1, Math.round(Number(l?.quantity) || 1));
  const returnedQty = new Map();
  const returnedCodes = new Map();
  for (const r of priorReturns) {
    (r.line_indexes || []).forEach((i, k) => {
      const saved = Array.isArray(r.lines) ? r.lines[k] : null;
      const q = saved && saved.quantity != null ? qtyOf(saved) : qtyOf(allLines[i]);
      returnedQty.set(i, (returnedQty.get(i) || 0) + q);
      const codes = returnedCodes.get(i) || new Set();
      for (const c of (saved && saved.unit_codes) || []) codes.add(String(c).toUpperCase());
      returnedCodes.set(i, codes);
    });
  }

  // سطرٌ بأكثر من قطعة يُرجع منه بعضه (lineParts[i] = { qty, unitCodes })، وبلا جزءٍ يُرجع ما بقي منه كلّه
  const returnedLines = [];
  for (const i of lineIndexes) {
    const line = allLines[i];
    const full = qtyOf(line);
    const left = full - (returnedQty.get(i) || 0);
    if (left <= 0) return { error: "line_already_returned", index: i };
    const part = lineParts ? (lineParts[i] || lineParts[String(i)] || null) : null;
    if (!part) {
      returnedLines.push(left === full ? line : { ...line, quantity: left });
      continue;
    }
    if (line.part_label) return { error: "invalid_line_part", index: i };
    const q = Math.round(Number(part.qty) || 0);
    if (q < 1 || q > left) return { error: "invalid_line_part", index: i, left };
    const gone = returnedCodes.get(i) || new Set();
    const codes = [...new Set((Array.isArray(part.unitCodes) ? part.unitCodes : []).map((c) => String(c || "").trim().toUpperCase()).filter(Boolean))];
    if (codes.length > q || codes.some((c) => gone.has(c))) return { error: "invalid_line_part", index: i };
    returnedLines.push({ ...line, quantity: q, unit_codes: codes });
  }

  return { sale, allLines, returnedLines };
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
  const partsBack = [];
  for (const l of returnedLines) {
    if (l.part_label) {
      const back = await returnSetPart(client, l);
      if (back.error) return back;
      partsBack.push(back);
      continue;
    }
    // ⚠ sale_lines.quantity من نوع numeric(12,3) فيصل نصًّا "1.000" —
    // وLIMIT يرفضه (22P02) فكان كل مرتجع يفشل بخطأ خادم. عددٌ صحيح هنا.
    const qty = Math.round(Number(l.quantity) || 0);
    // القطع المختارة برموزها تعود هي بعينها، والباقي من وحدات هذه الفاتورة أولًا (sale_id) ثم القديم قبل 045
    const codes = Array.isArray(l.unit_codes) ? l.unit_codes : [];
    const { rows: byCode } = codes.length
      ? await client.query(
        `select id from item_units where item_id = $1 and sold = true and upper(code) = any($2::text[])`,
        [l.item_id, codes.map((c) => String(c).toUpperCase())]
      )
      : { rows: [] };
    if (byCode.length < codes.length) {
      return { error: "unit_mismatch", itemId: l.item_id, available: byCode.length, requested: codes.length };
    }
    const { rows: rest } = qty > byCode.length
      ? await client.query(
        `select id from item_units where item_id = $1 and sold = true and not (id = any($4::uuid[]))
          order by (sale_id is not distinct from $3) desc, code limit $2`,
        [l.item_id, qty - byCode.length, l.sale_id || null, byCode.map((r) => r.id)]
      )
      : { rows: [] };
    const soldUnits = [...byCode, ...rest];
    if (soldUnits.length < qty) {
      return { error: "unit_mismatch", itemId: l.item_id, available: soldUnits.length, requested: qty };
    }
    const ids = soldUnits.map((r) => r.id);
    if (restock === "damaged") {
      await client.query(`update item_units set sold = false, issued = true, sale_id = null where id = any($1::uuid[])`, [ids]);
    } else {
      await client.query(`update item_units set sold = false, sale_id = null where id = any($1::uuid[])`, [ids]);
    }
    unitIds.push(...ids);
  }
  return { unitIds, partsBack };
}

/**
 * جزءٌ مرتجع من طقم (migration 066): يعود وزنه ونصيبه من المصنعية إلى بقايا طقمه
 * إن لم تُكوَّد بعد، وإلا صار بقايا جديدة («جزءٌ مرتجع») للتكويد. رمز الطقم لا يعود.
 */
async function returnSetPart(client, l) {
  const { rows } = await client.query("select * from items where id = $1 for update", [l.item_id]);
  const set = rows[0];
  if (!set) return { error: "item_not_found", itemId: l.item_id };
  const w = Number(l.weight_snapshot) || 0;
  const wm = Number(l.workmanship_snapshot) || 0;
  const label = String(l.part_label).split(" من طقم ")[0];
  const { rows: owned } = await client.query(
    "select id from item_units where item_id = $1 and sold = false and issued = false limit 1", [set.id]);
  if (set.remnant && owned[0]) {
    await client.query(
      `update items set weight = round((weight + $2)::numeric, 3), workmanship = coalesce(workmanship, 0) + $3,
              set_parts = coalesce(set_parts, '[]'::jsonb) || $4::jsonb where id = $1`,
      [set.id, w, wm, JSON.stringify([{ label, weight: w }])]
    );
    return { itemId: set.id, weight: w, mode: "merged" };
  }
  const ref = await nextRef(client, "items", set.branch_id, "ITM");
  const { rows: ni } = await client.query(
    `insert into items (branch_id, ref, lot_id, category_id, karat, weight, cost_per_gram, workmanship,
                        remnant, remnant_of, set_parts)
     values ($1,$2,$3,$4,$5,$6,$7,$8, true, $9, $10) returning id`,
    [set.branch_id, ref, set.lot_id, set.category_id, set.karat, w, set.cost_per_gram, wm, set.id, JSON.stringify([{ label, weight: w }])]
  );
  await client.query("insert into item_units (item_id, code) values ($1, $2)", [ni[0].id, ref]);
  return { itemId: ni[0].id, weight: w, mode: "new", code: ref };
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
  saleBlockedByStocktake,
  getOpenBusinessDay,
  requireBusinessDay,
  reserveSaleLines,
  insertSaleLines,
  postGoldMovement,
  loadSaleForReturn,
  computeReturnAmounts,
  restockReturnedLines,
  insertCashTx,
  insertReturnReceipt,
};
