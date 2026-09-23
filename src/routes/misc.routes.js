import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { extractInclusiveTax, roundMoney } from "../domain/money.js";
import { fineWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";
import {
  computeReturnAmounts, getOpenBusinessDay, insertCashTx, insertReturnReceipt, insertSaleLines,
  isStocktakeLocked, loadSaleForReturn, nextRef, postGoldMovement, reserveSaleLines, restockReturnedLines,
} from "../domain/saleOps.js";

const router = Router();

/**
 * الحجوزات (reservations)، الإصلاحات (repairs)، والمرتجعات (returns) كانت
 * الثلاثة محلية بالكامل (window.storage فقط) رغم وجود جداول أساسية لها
 * أصلًا في schema.sql — بلا أي endpoint يكتب فيها. تختفي بعد إعادة تحميل
 * الصفحة تمامًا كسبب البلاغ الأصلي عن الخزنة (raجع migration 013).
 *
 * addToSource/deductFromSource في المرجع (المُستخدَمتان في الثلاثة لتحريك
 * النقد بين الخزنة/اليومي) كانتا كذلك محليتين بالكامل — moveCash أدناه
 * مكافئهما الحقيقي: يكتب cash_tx فعليًا ويُرحّل قيد يومية متوازن، بنفس
 * خريطة الحسابات CASH_ACCOUNTS المستخدَمة أصلًا في expenses.routes.js.
 */

const CASH_ACCOUNTS = {
  safe_cash: { pool: "safe", method: "cash", account: "1110" },
  safe_network: { pool: "safe", method: "network", account: "1120" },
  daily_cash: { pool: "daily", method: "cash", account: "1130" },
  daily_network: { pool: "daily", method: "network", account: "1140" },
};

// كل مصدر تمويل يترجم لحساب نقدي في CATEGORY_TO_ACCOUNT (chart.js) —
// مطابقة سطرًا بسطر لِما تحتاجه الأنواع الثلاثة هنا تحديدًا.
const CATEGORY_ACCOUNTS = {
  customer_deposit: "2210",
  customer_deposit_refund: "2210",
  repair_income: "4130",
  repair_gold_added: "5320", // لا يُستخدَم هنا (وزن لا نقد) — موثَّق للمرجعية فقط.
  sales_return: "4190",
};

// ⚠ journal_entries.op_type مفتاحٌ أجنبي على posting_rules، وفئتا
// customer_deposit_refund وsales_return ليستا فيه — فكان استرداد العربون
// والإرجاع السريع يفشلان بخطأ خادم. القيد يأخذ نوع العملية المزروع.
const OP_TYPE_FOR_CATEGORY = {
  customer_deposit_refund: "customer_deposit",
  sales_return: "sale_return",
};

function normalizeFundingSource(id) {
  return CASH_ACCOUNTS[id] ? id : "daily_cash";
}

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

/**
 * يكتب سطر cash_tx فعليًا (in/out) + قيد يومية متوازن ضد حساب category
 * المطابق — بديل addToSource/deductFromSource المحليين في المرجع.
 * direction: 'in' | 'out'.
 */
async function moveCash(client, { branchId, businessDayId, direction, sourceId, amount, category, note, refTable, refId, createdBy }) {
  const amt = roundMoney(amount);
  if (!(amt > 0)) return null;
  const src = normalizeFundingSource(sourceId);
  const { pool, method, account: cashAccount } = CASH_ACCOUNTS[src];
  const categoryAccount = CATEGORY_ACCOUNTS[category];

  const { rows: txRows } = await client.query(
    `insert into cash_tx
       (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     returning *`,
    [branchId, businessDayId, pool, method, direction, amt, category, refTable, refId, note, createdBy]
  );

  let journalEntryId = null;
  if (categoryAccount) {
    journalEntryId = await postJournalEntry(client, {
      branchId,
      businessDayId,
      opType: OP_TYPE_FOR_CATEGORY[category] || category,
      refTable,
      refId,
      description: note,
      createdBy,
      lines: direction === "in"
        ? [{ account: cashAccount, side: "debit", amount: amt }, { account: categoryAccount, side: "credit", amount: amt }]
        : [{ account: categoryAccount, side: "debit", amount: amt }, { account: cashAccount, side: "credit", amount: amt }],
    });
  }

  return { cashTx: txRows[0], journalEntryId, fundingSource: src };
}

// ══════════════════════════════════════════════════════════════
//  الحجوزات (reservations) — handleAddReservation/handleCancelReservation
// ══════════════════════════════════════════════════════════════

router.use("/reservations", authenticate, requirePage("sales"));

router.get("/reservations", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select r.*, c.name as customer_name
           from reservations r left join customers c on c.id = r.customer_id
          where r.branch_id = $1 order by r.created_at desc limit 500`,
        [req.auth.branchId]
      );
      return { reservations: rows };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/reservations", async (req, res, next) => {
  const body = req.body || {};
  const total = roundMoney(body.total);
  const deposit = roundMoney(body.deposit);
  const method = body.method === "network" ? "network" : "cash";
  if (!body.customerId) return res.status(400).json({ error: "customer_required" });
  if (!(total > 0)) return res.status(400).json({ error: "invalid_total" });
  if (deposit < 0 || deposit > total) return res.status(400).json({ error: "invalid_deposit" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: custRows } = await client.query(
        "select id, name from customers where id = $1 and branch_id = $2",
        [body.customerId, req.auth.branchId]
      );
      if (!custRows[0]) return { error: "customer_not_found" };

      if (body.itemId) {
        const { rows: itemRows } = await client.query(
          "select id from items where id = $1 and branch_id = $2",
          [body.itemId, req.auth.branchId]
        );
        if (!itemRows[0]) return { error: "item_not_found" };
      }

      const businessDayId = await openDay(client, req.auth.branchId);
      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from reservations where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `RSV-${String(refRows[0].n).padStart(6, "0")}`;

      const { rows: rsvRows } = await client.query(
        `insert into reservations
           (branch_id, ref, customer_id, item_id, total, deposit, remaining, description, method, business_day_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning *`,
        [
          req.auth.branchId, ref, body.customerId, body.itemId || null, total, deposit,
          roundMoney(total - deposit), body.description || null, method, businessDayId, req.auth.userId,
        ]
      );
      const reservation = rsvRows[0];

      let cashResult = null;
      if (deposit > 0) {
        cashResult = await moveCash(client, {
          branchId: req.auth.branchId, businessDayId, direction: "in",
          sourceId: method === "network" ? "daily_network" : "daily_cash", amount: deposit,
          category: "customer_deposit", note: `عربون حجز — ${custRows[0].name}`,
          refTable: "reservations", refId: reservation.id, createdBy: req.auth.userId,
        });
      }

      // القطعة تُحجز فلا تُباع لغيره.
      if (body.itemId) {
        await client.query(`update items set reserved_for = $1 where id = $2`, [reservation.id, body.itemId]);
      }

      return { reservation: { ...reservation, customerName: custRows[0].name }, cashTx: cashResult?.cashTx || null };
    });
    if (result.error) {
      const status = result.error.endsWith("_not_found") ? 404 : 409;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/reservations/:id/cancel", async (req, res, next) => {
  const refund = !!req.body?.refund;
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        "select * from reservations where id = $1 and branch_id = $2 for update",
        [req.params.id, req.auth.branchId]
      );
      const reservation = rows[0];
      if (!reservation) return { error: "reservation_not_found" };
      if (reservation.status !== "open") return { error: "reservation_not_open", status: reservation.status };

      await client.query(
        `update reservations set status = 'cancelled', cancelled_at = now(), cancelled_by = $1, refunded = $2 where id = $3`,
        [req.auth.userId, refund, reservation.id]
      );

      let cashResult = null;
      if (refund && Number(reservation.deposit) > 0) {
        const { rows: custRows } = await client.query(
          "select name from customers where id = $1", [reservation.customer_id]
        );
        const businessDayId = await openDay(client, req.auth.branchId);
        cashResult = await moveCash(client, {
          branchId: req.auth.branchId, businessDayId, direction: "out",
          sourceId: reservation.method === "network" ? "daily_network" : "daily_cash",
          amount: Number(reservation.deposit), category: "customer_deposit_refund",
          note: `إرجاع عربون — ${custRows[0]?.name || ""}`.trim(),
          refTable: "reservations", refId: reservation.id, createdBy: req.auth.userId,
        });
      }

      if (reservation.item_id) {
        await client.query(`update items set reserved_for = null where id = $1`, [reservation.item_id]);
      }

      return { ok: true, refunded: refund, cashTx: cashResult?.cashTx || null };
    });
    if (result.error) {
      const status = result.error === "reservation_not_found" ? 404 : 409;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ══════════════════════════════════════════════════════════════
//  الإصلاحات (repairs) — handleAddRepair (إصلاح عميل: تكلفة/مكسب فقط،
//  لا تعديل وزن قطعة — تلك دورة أكبر منفصلة، خارج نطاق هذي الهجرة).
// ══════════════════════════════════════════════════════════════

router.post(
  "/repairs",
  authenticate,
  requirePage("repairs"),
  requireNotDenied("repair"),
  async (req, res, next) => {
    const body = req.body || {};
    const cost = roundMoney(body.cost);
    const profit = roundMoney(body.profit);
    if (profit > 0 && !CASH_ACCOUNTS[body.fundingSource]) {
      return res.status(400).json({ error: "invalid_funding_source" });
    }

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const businessDayId = await openDay(client, req.auth.branchId);
        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from repairs where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `REP-${String(refRows[0].n).padStart(6, "0")}`;

        const { rows: repRows } = await client.query(
          `insert into repairs
             (branch_id, ref, customer_name, description, cost, profit, funding_source, notes, business_day_id, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           returning *`,
          [
            req.auth.branchId, ref, body.customerName || null, body.description || null,
            cost, profit, body.fundingSource || null, body.notes || null, businessDayId, req.auth.userId,
          ]
        );
        const repair = repRows[0];

        let cashResult = null;
        if (profit > 0) {
          cashResult = await moveCash(client, {
            branchId: req.auth.branchId, businessDayId, direction: "in",
            sourceId: body.fundingSource, amount: profit, category: "repair_income",
            note: `مكسب إصلاح${body.customerName ? " - " + body.customerName : ""}`,
            refTable: "repairs", refId: repair.id, createdBy: req.auth.userId,
          });
        }

        return { repair, cashTx: cashResult?.cashTx || null };
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  المرتجعات (returns) — handleReturnSale
// ══════════════════════════════════════════════════════════════

// ⚠ إصلاح صلاحية: هذا المسار يخدم handleReturnSale (الإرجاع السريع من
// SalesHistoryPage/SaleDetailModal — بوابته الفعلية `role !== "employee"`
// أو صلاحية "salesHistory"، لا "salesReturn"). المسار الأكبر أدناه
// (/sales/:id/return-full) هو من يخدم شاشة "استرجاع مبيعات" المخصصة
// فعليًا، وهو من يُقصر على "salesReturn".
router.post(
  "/sales/:id/return",
  authenticate,
  requirePage("salesHistory"),
  requireNotDenied("sale"),
  async (req, res, next) => {
    const body = req.body || {};
    const lineIndexes = Array.isArray(body.lineIndexes) ? body.lineIndexes : null;
    const refundSource = body.refundSource || null;
    if (refundSource !== "credit" && !CASH_ACCOUNTS[refundSource]) {
      return res.status(400).json({ error: "invalid_refund_source" });
    }

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const { rows: saleRows } = await client.query(
          "select * from sales where id = $1 and branch_id = $2 for update",
          [req.params.id, req.auth.branchId]
        );
        const sale = saleRows[0];
        if (!sale) return { error: "sale_not_found" };
        if (refundSource === "credit" && sale.payment_method !== "credit") {
          return { error: "credit_refund_requires_credit_sale" };
        }

        // ⚠ ORDER BY line_no إلزامي — يطابق تمامًا الترتيب الذي يبنيه
        // bootstrap.routes.js لهذا العميل نفسه، فالفهرس المُرسَل من الشاشة
        // (lineIndexes) يشير لنفس السطر فعليًا على الخادم.
        const { rows: allLines } = await client.query(
          `select * from sale_lines where sale_id = $1 order by line_no`,
          [sale.id]
        );
        if (!allLines.length) return { error: "no_lines" };

        const idxs = lineIndexes && lineIndexes.length ? lineIndexes : allLines.map((_, i) => i);
        const returnedLines = idxs.map((i) => allLines[i]).filter(Boolean);
        if (!returnedLines.length) return { error: "invalid_line_indexes" };

        // ⚠ نفس تقريب المرجع تمامًا: لا يوجد ربط مخزَّن بين سطر البيع
        // ووحدات item_units المحدَّدة التي بِيعت (sale_lines لا تُسجّل
        // unit_id لكل قطعة) — فالإرجاع يُعيد أي N وحدة مباعة من نفس
        // الصنف لغير مباعة، لا وحدة بعينها. القيد نفسه (المبلغ/الوزن)
        // صحيح تمامًا بصرف النظر عن أي وحدة فعليًا أُعيدت.
        const refund = roundMoney(returnedLines.reduce((a, l) => a + Number(l.unit_price) * Number(l.quantity), 0));

        for (const l of returnedLines) {
          // ⚠ quantity numeric يصل نصًّا "1.000" — LIMIT يحتاج عددًا صحيحًا.
          const qty = Math.round(Number(l.quantity) || 0);
          const { rows: soldUnits } = await client.query(
            `select id from item_units where item_id = $1 and sold = true order by code limit $2`,
            [l.item_id, qty]
          );
          if (soldUnits.length < qty) {
            return { error: "unit_mismatch", itemId: l.item_id, available: soldUnits.length, requested: qty };
          }
          await client.query(
            `update item_units set sold = false where id = any($1::uuid[])`,
            [soldUnits.map((r) => r.id)]
          );
        }

        const businessDayId = sale.business_day_id;
        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from returns where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `RTN-${String(refRows[0].n).padStart(6, "0")}`;

        const weightByKarat = new Map();
        for (const l of returnedLines) {
          const w = Number(l.weight_snapshot) * Number(l.quantity);
          weightByKarat.set(l.karat, (weightByKarat.get(l.karat) || 0) + w);
        }
        const totalWeight = [...weightByKarat.values()].reduce((a, w) => a + w, 0);

        const { rows: retRows } = await client.query(
          `insert into returns
             (branch_id, ref, sale_id, business_day_id, amount, weight, reason,
              line_indexes, lines, full_return, refund_source, customer_id, customer_name, created_by)
           values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14)
           returning *`,
          [
            req.auth.branchId, ref, sale.id, businessDayId, refund, totalWeight, body.note || null,
            JSON.stringify(idxs), JSON.stringify(returnedLines), idxs.length === allLines.length,
            refundSource, sale.customer_id, sale.customer_name, req.auth.userId,
          ]
        );
        const returnRec = retRows[0];

        // ⚠ الذهب يعود للمخزون (1210) — نفس اتجاه posting_rules.sale_return
        // المزروع أصلًا في seed.sql (from: null, to: 1210)، بلا endpoint
        // يستهلكه قبل الآن.
        for (const [karat, weight] of weightByKarat) {
          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,'sale_return',$3,$4,$5, null,'1210', 'returns',$6,$7,$8)`,
            [req.auth.branchId, businessDayId, karat, weight, fineWeight(weight, karat), returnRec.id, `مرتجع ${sale.ref}`, req.auth.userId]
          );
        }

        let receiptRec = null;
        let cashResult = null;
        if (refundSource === "credit") {
          // ⚠ خصم من ذمة العميل لا خروج نقد: الفاتورة آجلة لم تُحصَّل
          // أصلًا — ردّ نقد هنا يعني خسارة مضاعفة (نفس تحفّظ المرجع صراحةً).
          const { rows: recRows } = await client.query(
            `select count(*)::int + 1 as n from receipts where branch_id = $1`,
            [req.auth.branchId]
          );
          const receiptRef = `RCP-${String(recRows[0].n).padStart(6, "0")}`;
          const { rows: rcRows } = await client.query(
            `insert into receipts
               (branch_id, ref, customer_id, customer_name, sale_id, amount, method, category, note, business_day_id, created_by)
             values ($1,$2,$3,$4,$5,$6,'adjust','sales_return',$7,$8,$9)
             returning *`,
            [
              req.auth.branchId, receiptRef, sale.customer_id, sale.customer_name, sale.id, -refund,
              `خصم مرتجع ${sale.ref || ""}`.trim(), businessDayId, req.auth.userId,
            ]
          );
          receiptRec = rcRows[0];
        } else {
          cashResult = await moveCash(client, {
            branchId: req.auth.branchId, businessDayId, direction: "out",
            sourceId: refundSource, amount: refund, category: "sales_return",
            note: `مرتجع فاتورة ${sale.ref || ""}`.trim(),
            refTable: "returns", refId: returnRec.id, createdBy: req.auth.userId,
          });
        }

        return { return: returnRec, receipt: receiptRec, cashTx: cashResult?.cashTx || null };
      });
      if (result.error) {
        const status = result.error === "sale_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  استرجاع مبيعات كامل — processSalesReturn (شاشة "استرجاع مبيعات" المخصصة)
// ══════════════════════════════════════════════════════════════
//
// القيد (buildReturnJournal في المرجع):
//   مدين 4190 مردودات المبيعات  الصافي
//   مدين 2220 الضريبة            الضريبة
//   دائن حساب الوجهة             الإجمالي (نقد/شبكة/ذمم)
//
// ⚠ ثلاثة إصلاحات هنا:
//  ① الإجمالي = قيمة الأسطر كما دُفعت (سعر السطر شامل الضريبة)، والضريبة
//     جزءٌ منه — كانت تُضاف فوقه فيُردّ للعميل أكثر مما دفع.
//  ② لا سطر تكلفة (1200/5100): النظام دوري لا يقيّد تكلفة عند البيع،
//     و1200/5100 حسابا مجموعة — مطابقةً للمرجع الأحدث.
//  ③ حركة النقد تُكتب بلا قيد ثانٍ: moveCash كان يرحّل 4190/النقد مرةً
//     أخرى فوق قيد المرتجع، فيتضاعف أثرهما في الأستاذ.
const REFUND_TARGET_ACCOUNTS = {
  daily_cash: "1130",
  safe_cash: "1110",
  network: "1120", // ⚠ "شبكة" هنا يعني شبكة الخزنة تحديدًا (1120) — لا شبكة اليومي (1140)، مطابقةً لـREFUND_TARGETS في workflow.js حرفيًا.
  credit: "1310",
};
const REFUND_TARGET_CASH_SOURCE = {
  daily_cash: "daily_cash",
  safe_cash: "safe_cash",
  network: "safe_network",
};
const RETURN_RESTOCK = {
  changed_mind: "available", wrong_size: "available", wrong_item: "available",
  defect: "damaged", damaged: "damaged",
};

function returnJournalLines(amounts, creditAccount) {
  const lines = [];
  if (amounts.net > 0) lines.push({ account: "4190", side: "debit", amount: amounts.net });
  if (amounts.tax > 0) lines.push({ account: "2220", side: "debit", amount: amounts.tax });
  lines.push({ account: creditAccount, side: "credit", amount: amounts.gross });
  return lines;
}

async function insertReturnRow(client, { branchId, sale, allLines, lineIndexes, returnedLines, amounts, businessDayId, refundSource, note, createdBy, exchange = null }) {
  const ref = await nextRef(client, "returns", branchId, "RTN");
  const { rows } = await client.query(
    `insert into returns
       (branch_id, ref, sale_id, business_day_id, amount, weight, reason,
        line_indexes, lines, full_return, refund_source, customer_id, customer_name, created_by,
        exchange_settle, exchange_diff)
     values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14, $15,$16)
     returning *`,
    [
      branchId, ref, sale.id, businessDayId, amounts.gross, amounts.totalWeight, note || null,
      JSON.stringify(lineIndexes), JSON.stringify(returnedLines), lineIndexes.length === allLines.length,
      refundSource, sale.customer_id, sale.customer_name, createdBy,
      exchange?.settle || null, exchange ? exchange.diff : null,
    ]
  );
  return rows[0];
}

router.post(
  "/sales/:id/return-full",
  authenticate,
  requirePage("salesReturn"),
  requireNotDenied("sale"),
  async (req, res, next) => {
    const body = req.body || {};
    const lineIndexes = Array.isArray(body.lineIndexes) ? body.lineIndexes : [];
    const reasonId = body.reasonId || null;
    const refundTarget = body.refundTarget || null;
    const restock = RETURN_RESTOCK[reasonId];

    if (!lineIndexes.length) return res.status(400).json({ error: "no_lines_selected" });
    if (!restock) return res.status(400).json({ error: "invalid_reason" });
    if (!REFUND_TARGET_ACCOUNTS[refundTarget]) return res.status(400).json({ error: "invalid_refund_target" });

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        const loaded = await loadSaleForReturn(client, req.auth.branchId, req.params.id, lineIndexes);
        if (loaded.error) return loaded;
        const { sale, allLines, returnedLines } = loaded;
        // ⚠ الآجل يُخصم من الدَّين لا يُردّ نقدًا — نفس validateReturnRequest.
        if (refundTarget !== "credit" && sale.payment_method === "credit") {
          return { error: "credit_sale_requires_credit_refund" };
        }

        const amounts = computeReturnAmounts(sale, allLines, returnedLines);
        if (!(amounts.gross > 0)) return { error: "zero_amount" };

        const restocked = await restockReturnedLines(client, returnedLines, restock);
        if (restocked.error) return restocked;

        const businessDayId = sale.business_day_id;
        const returnRec = await insertReturnRow(client, {
          branchId: req.auth.branchId, sale, allLines, lineIndexes, returnedLines, amounts,
          businessDayId, refundSource: refundTarget, note: body.note, createdBy: req.auth.userId,
        });

        await postGoldMovement(client, {
          branchId: req.auth.branchId, businessDayId, opType: "sale_return",
          weightByKarat: amounts.weightByKarat, refTable: "returns", refId: returnRec.id,
          note: `مرتجع ${sale.ref}`, createdBy: req.auth.userId,
        });

        const journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId, opType: "sale_return",
          refTable: "returns", refId: returnRec.id,
          description: `مرتجع مبيعات — ${sale.ref}`, createdBy: req.auth.userId,
          lines: returnJournalLines(amounts, REFUND_TARGET_ACCOUNTS[refundTarget]),
        });

        let receiptRec = null;
        let cashTx = null;
        if (refundTarget === "credit") {
          receiptRec = await insertReturnReceipt(client, {
            branchId: req.auth.branchId, sale, amount: -amounts.gross,
            note: `خصم مرتجع ${returnRec.ref}`, businessDayId, createdBy: req.auth.userId,
          });
        } else {
          const { pool, method } = CASH_ACCOUNTS[REFUND_TARGET_CASH_SOURCE[refundTarget]];
          cashTx = await insertCashTx(client, {
            branchId: req.auth.branchId, businessDayId, pool, method, direction: "out",
            amount: amounts.gross, category: "sales_return", refTable: "returns", refId: returnRec.id,
            note: `مرتجع ${returnRec.ref} — ${sale.ref}`, createdBy: req.auth.userId,
          });
        }

        return {
          return: { ...returnRec, restock, journalEntryId },
          receipt: receiptRec,
          cashTx,
          amounts: { net: amounts.net, tax: amounts.tax, gross: amounts.gross, cost: amounts.cost },
        };
      });
      if (result.error) {
        const status = result.error === "sale_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  الاستبدال — processExchange: مرتجعٌ وفاتورةٌ جديدة في معاملةٍ واحدة
// ══════════════════════════════════════════════════════════════
//
// ليس عمليةً ثالثة بمحاسبةٍ خاصة: مستندان مرتبطان — مرتجعٌ كامل الأثر
// (إيراد مردود، وزن يعود) وفاتورةٌ كاملة الأثر (إيراد، وزن يخرج). طرفا
// النقد في القيدين حسابٌ واحد (1130 نقدًا · 1140 شبكة · 1310 ذمم العميل)
// فيتقاصّان في الأستاذ إلى الفرق، والدرج يتحرّك بالفرق وحده.
//
// diff = إجمالي الجديدة − إجمالي المرتجع: موجب يدفعه العميل، سالب يُردّ له.
// الضريبة على الجديدة تتبع الفاتورة الأصل (خاضعة أم لا) بالمعدّل الحالي.
// المرتجع والفاتورة على يوم العمل المفتوح الآن.
const EXCHANGE_SETTLE = {
  cash: { account: "1130", opType: "sale_cash", paymentMethod: "cash", method: "cash" },
  card: { account: "1140", opType: "sale_card", paymentMethod: "card", method: "network" },
  credit: { account: "1310", opType: "sale_credit", paymentMethod: "credit", method: null },
};

router.post(
  "/sales/:id/exchange",
  authenticate,
  requirePage("salesReturn"),
  requireNotDenied("sale"),
  async (req, res, next) => {
    const body = req.body || {};
    const lineIndexes = Array.isArray(body.lineIndexes) ? body.lineIndexes : [];
    const newLines = Array.isArray(body.newLines) ? body.newLines : [];
    const reasonId = body.reasonId || "changed_mind";
    const restock = RETURN_RESTOCK[reasonId];
    const settle = EXCHANGE_SETTLE[body.settle];

    if (!lineIndexes.length) return res.status(400).json({ error: "no_lines_selected" });
    if (!restock) return res.status(400).json({ error: "invalid_reason" });
    if (!settle) return res.status(400).json({ error: "invalid_exchange_settle" });
    if (!newLines.length) return res.status(400).json({ error: "no_new_lines" });
    for (const l of newLines) {
      if (!l.itemId || !(Number(l.quantity) > 0) || !(Number(l.unitPrice) > 0)) {
        return res.status(400).json({ error: "invalid_line", line: l });
      }
    }

    try {
      const result = await withBranch(req.auth.branchId, async (client) => {
        if (await isStocktakeLocked(client, req.auth.branchId)) return { error: "stocktake_locked" };
        const businessDay = await getOpenBusinessDay(client, req.auth.branchId);
        if (!businessDay) return { error: "no_open_business_day" };

        const loaded = await loadSaleForReturn(client, req.auth.branchId, req.params.id, lineIndexes);
        if (loaded.error) return loaded;
        const { sale, allLines, returnedLines } = loaded;
        if (body.settle === "credit" && !sale.customer_id) return { error: "credit_settle_requires_customer" };

        const amounts = computeReturnAmounts(sale, allLines, returnedLines);
        if (!(amounts.gross > 0)) return { error: "zero_amount" };

        // ① القطع العائدة أولًا، ثم الجديدة مع استثناء العائدة للتوّ.
        const restocked = await restockReturnedLines(client, returnedLines, restock);
        if (restocked.error) return restocked;
        const reserved = await reserveSaleLines(client, req.auth.branchId, newLines, { excludeUnitIds: restocked.unitIds });
        if (reserved.error) return reserved;

        const { rows: settingsRows } = await client.query(
          "select tax_rate from branch_settings where branch_id = $1",
          [req.auth.branchId]
        );
        const taxApplicable = !!sale.tax_applicable;
        const taxRate = taxApplicable ? Number(settingsRows[0]?.tax_rate ?? 0.15) : 0;
        const total = roundMoney(reserved.subtotal);
        const taxAmount = taxApplicable ? extractInclusiveTax(total, taxRate) : 0;
        const netAmount = roundMoney(total - taxAmount);
        const diff = roundMoney(total - amounts.gross);

        // الردّ نقدًا لا يتجاوز رصيد الدرج (نفس حارس المرجع).
        if (body.settle === "cash" && diff < -0.005) {
          const { rows: balRows } = await client.query(
            `select coalesce(sum(case when direction='in' then amount else -amount end), 0) as balance
               from cash_tx where branch_id = $1 and pool = 'daily' and method = 'cash'`,
            [req.auth.branchId]
          );
          const available = roundMoney(balRows[0]?.balance);
          if (Math.abs(diff) > available + 0.01) {
            return { error: "insufficient_daily_cash", available, requested: Math.abs(diff) };
          }
        }

        // ② الفاتورة الجديدة
        const saleRef = await nextRef(client, "sales", req.auth.branchId, "SALE");
        const { rows: saleRows } = await client.query(
          `insert into sales
             (branch_id, ref, business_day_id, customer_id, customer_name, payment_method,
              price24_snapshot, subtotal, total, tax_applicable, tax_rate, tax_amount, net_amount,
              seller_id, created_by, exchange_of_sale_id)
           values ($1,$2,$3,$4,$5,$6, $7,$8,$9,$10,$11,$12,$13, $14,$14,$15)
           returning *`,
          [
            req.auth.branchId, saleRef, businessDay.id, sale.customer_id, sale.customer_name, settle.paymentMethod,
            Number(body.price24Snapshot) || 0, total, total, taxApplicable, taxRate, taxAmount, netAmount,
            req.auth.userId, sale.id,
          ]
        );
        const newSale = saleRows[0];
        await insertSaleLines(client, newSale.id, reserved.resolvedLines);

        // ③ المرتجع مربوطًا بالفاتورة الجديدة
        const returnRec = await insertReturnRow(client, {
          branchId: req.auth.branchId, sale, allLines, lineIndexes, returnedLines, amounts,
          businessDayId: businessDay.id, refundSource: `exchange_${body.settle}`, note: body.note,
          createdBy: req.auth.userId, exchange: { settle: body.settle, diff },
        });
        await client.query(`update returns set exchange_sale_id = $1 where id = $2`, [newSale.id, returnRec.id]);

        // ④ الوزن: يعود المرتجع ويخرج الجديد
        await postGoldMovement(client, {
          branchId: req.auth.branchId, businessDayId: businessDay.id, opType: "sale_return",
          weightByKarat: amounts.weightByKarat, refTable: "returns", refId: returnRec.id,
          note: `مرتجع استبدال ${returnRec.ref}`, createdBy: req.auth.userId,
        });
        await postGoldMovement(client, {
          branchId: req.auth.branchId, businessDayId: businessDay.id, opType: "sale",
          weightByKarat: reserved.weightByKarat, refTable: "sales", refId: newSale.id,
          note: `بيع استبدال ${newSale.ref}`, createdBy: req.auth.userId,
        });

        // ⑤ القيدان — طرفهما النقدي حسابٌ واحد فيتقاصّان إلى الفرق
        const returnJournalId = await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId: businessDay.id, opType: "sale_return",
          refTable: "returns", refId: returnRec.id,
          description: `مرتجع استبدال — ${sale.ref}`, createdBy: req.auth.userId,
          lines: returnJournalLines(amounts, settle.account),
        });
        const saleJournalLines = [{ account: settle.account, side: "debit", amount: total }];
        if (taxAmount > 0) {
          saleJournalLines.push({ account: "4140", side: "credit", amount: netAmount });
          saleJournalLines.push({ account: "2220", side: "credit", amount: taxAmount });
        } else {
          saleJournalLines.push({ account: "4140", side: "credit", amount: total });
        }
        const saleJournalId = await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId: businessDay.id, opType: settle.opType,
          refTable: "sales", refId: newSale.id,
          description: `فاتورة استبدال ${newSale.ref} — بدل ${sale.ref}`, createdBy: req.auth.userId,
          lines: saleJournalLines,
        });

        // ⑥ الدرج بالفرق وحده — أو ذمة العميل
        let cashTx = null;
        let receipt = null;
        if (settle.method && Math.abs(diff) > 0.005) {
          cashTx = await insertCashTx(client, {
            branchId: req.auth.branchId, businessDayId: businessDay.id, pool: "daily", method: settle.method,
            direction: diff > 0 ? "in" : "out", amount: Math.abs(diff),
            category: diff > 0 ? "sales_revenue" : "sales_return", refTable: "sales", refId: newSale.id,
            note: `فرق استبدال ${returnRec.ref} — ${sale.ref} ← ${newSale.ref}`, createdBy: req.auth.userId,
          });
        } else if (body.settle === "credit") {
          // المرتجع يُخصم من دَينه، والفاتورة الجديدة الآجلة تُضاف إليه.
          receipt = await insertReturnReceipt(client, {
            branchId: req.auth.branchId, sale, amount: -amounts.gross,
            note: `خصم مرتجع استبدال ${returnRec.ref}`, businessDayId: businessDay.id, createdBy: req.auth.userId,
          });
        }

        await client.query(
          `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
           values ($1,'create',$2,'returns',$3,$4)`,
          [req.auth.branchId, req.auth.userId, returnRec.id, JSON.stringify({
            kind: "exchange", fromSale: sale.ref, returnRef: returnRec.ref, newSale: newSale.ref,
            returned: amounts.gross, newTotal: total, diff, settle: body.settle,
          })]
        );

        return {
          return: { ...returnRec, exchange_sale_id: newSale.id, restock, journalEntryId: returnJournalId },
          sale: { ...newSale, journalEntryId: saleJournalId },
          saleLines: reserved.resolvedLines,
          cashTx,
          receipt,
          amounts: {
            returned: { net: amounts.net, tax: amounts.tax, gross: amounts.gross, cost: amounts.cost },
            newTotal: total, newTax: taxAmount, newNet: netAmount,
            diff, direction: diff > 0.005 ? "customer_pays" : diff < -0.005 ? "shop_refunds" : "even",
          },
        };
      });
      if (result.error) {
        const status = result.error === "sale_not_found" || result.error === "item_not_found" ? 404 : 409;
        return res.status(status).json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  سعر الذهب العالمي — fetchGoldPriceSAR (شاشة "سعر الذهب اليومي")
// ══════════════════════════════════════════════════════════════
//
// ⚠ إصلاح أمني/وظيفي حقيقي: النسخة الأصلية في الفرونت إند كانت تنادي
// https://api.anthropic.com/v1/messages مباشرة من المتصفح بلا أي مفتاح
// API إطلاقًا (x-api-key) — هذا لا يعمل أصلًا (يُرفض 401 من Anthropic)،
// وحتى لو أُضيف مفتاح فسيكون مكشوفًا لأي زائر لأنه في كود العميل. هنا
// السعر يُجلب من الخادم فقط (gold-api.com — عام، بلا مفتاح مطلوب) ويُحوَّل
// لريال سعودي بسعر الصرف الثابت المعروف (3.75)، مطابقةً تمامًا لمنطق
// helpers.js الأصلي (perOunceUsd / GRAMS_PER_OUNCE * USD_TO_SAR_PEG).
//
// ⚠ كاش بالذاكرة لمدة دقيقة: يمنع كل مستخدمي كل الفروع المفتوحين على
// الشاشة من ضرب gold-api.com بمعدل مرتفع غير ضروري (السعر العالمي أصلًا
// لا يتغيّر كل ثانية)، بلا حاجة لجدول قاعدة بيانات لبيانات عابرة كهذي.
const GRAMS_PER_OUNCE = 31.1034768;
const USD_TO_SAR_PEG = 3.75;
let goldPriceCache = { at: 0, data: null };
const GOLD_PRICE_CACHE_MS = 60 * 1000;

router.get("/gold-price", authenticate, async (req, res, next) => {
  try {
    if (goldPriceCache.data && Date.now() - goldPriceCache.at < GOLD_PRICE_CACHE_MS) {
      return res.json(goldPriceCache.data);
    }
    const response = await fetch("https://api.gold-api.com/price/XAU");
    if (!response.ok) throw new Error("gold_api_unavailable");
    const body = await response.json();
    const perOunceUsd = Number(body.price);
    if (!Number.isFinite(perOunceUsd) || perOunceUsd <= 0) throw new Error("gold_api_invalid_price");
    const perGramSar = roundMoney((perOunceUsd / GRAMS_PER_OUNCE) * USD_TO_SAR_PEG);
    const payload = { perGram: perGramSar, asOf: body.updatedAt || body.updated_at || new Date().toISOString() };
    goldPriceCache = { at: Date.now(), data: payload };
    res.json(payload);
  } catch (err) {
    // ⚠ لا نُفشل بـ500 خام هنا: الفرونت إند يعامل أي خطأ كـ"تعذر الاتصال
    // بالسعر العالمي" ويحتفظ بآخر سعر معروف — رسالة واضحة تكفي.
    console.error("gold-price fetch failed:", err.message);
    res.status(502).json({ error: "gold_price_unavailable" });
  }
});

export default router;
