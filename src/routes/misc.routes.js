import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireNotDenied } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { fineWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";

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
      opType: category,
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
          const { rows: soldUnits } = await client.query(
            `select id from item_units where item_id = $1 and sold = true order by code limit $2`,
            [l.item_id, l.quantity]
          );
          if (soldUnits.length < l.quantity) {
            return { error: "unit_mismatch", itemId: l.item_id, available: soldUnits.length, requested: l.quantity };
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
// ⚠ أعقد بكثير من /sales/:id/return أعلاه (الإرجاع السريع): تلك تكتب
// بسطر posting_rules.sale_return المبسَّط (4140/1130 فقط، بلا ضريبة ولا
// عكس تكلفة). processSalesReturn في المرجع كانت تبني قيدًا حقيقيًا:
// عكس صافي البيع (4190) + الضريبة (2220) + عكس تكلفة البضاعة المباعة
// (1200 مدين / 5100 دائن) + دائن حساب الوجهة المختارة (نقد/شبكة/آجل).
//
// ⚠ إصلاح حقيقي أُصلح هنا: computeReturnAmounts في المرجع كانت تقرأ
// l.unitCost || l.costSnapshot — حقلان لا يُكتبان في أي مكان بالمشروع
// كله (بحث كامل تأكيدي)، فكانت amounts.cost يساوي صفر دائمًا، وسطرا
// 1200/5100 لا يُكتبان أبدًا (محروسان بـ`if (cost > 0)`) — عكس التكلفة
// كان معطَّلًا بصمت منذ البداية. هنا التكلفة تُحسب فعليًا من نفس
// اللقطات المحفوظة أصلًا على كل سطر بيع (cost_per_gram_snapshot ×
// weight_snapshot + workmanship_snapshot × الكمية).
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
        const { rows: saleRows } = await client.query(
          "select * from sales where id = $1 and branch_id = $2 for update",
          [req.params.id, req.auth.branchId]
        );
        const sale = saleRows[0];
        if (!sale) return { error: "sale_not_found" };
        // ⚠ الآجل يُخصم من الدَّين لا يُردّ نقدًا — نفس تحقّق
        // validateReturnRequest صراحةً.
        if (refundTarget !== "credit" && sale.payment_method === "credit") {
          return { error: "credit_sale_requires_credit_refund" };
        }

        const { rows: allLines } = await client.query(
          `select * from sale_lines where sale_id = $1 order by line_no`,
          [sale.id]
        );
        for (const i of lineIndexes) {
          if (i < 0 || i >= allLines.length) return { error: "line_index_out_of_range", index: i };
        }

        // ⚠ منع الإرجاع المزدوج لنفس السطر — نفس فحص المرجع، هنا على
        // بيانات returns الحقيقية بدل مصفوفة محلية.
        const { rows: priorReturns } = await client.query(
          `select line_indexes from returns where sale_id = $1 and branch_id = $2`,
          [sale.id, req.auth.branchId]
        );
        const alreadyReturned = new Set();
        for (const r of priorReturns) {
          for (const i of r.line_indexes || []) alreadyReturned.add(i);
        }
        const dup = lineIndexes.find((i) => alreadyReturned.has(i));
        if (dup != null) return { error: "line_already_returned", index: dup };

        const returnedLines = lineIndexes.map((i) => allLines[i]);

        // ── الحساب: صافي + ضريبة (بمعدّل الفاتورة الفعلي) + تكلفة ──
        const net = roundMoney(returnedLines.reduce((a, l) => a + Number(l.unit_price) * Number(l.quantity), 0));
        const saleNet = roundMoney(allLines.reduce((a, l) => a + Number(l.unit_price) * Number(l.quantity), 0));
        const saleTax = Number(sale.tax_amount) || 0;
        const effectiveRate = saleNet > 0 ? saleTax / saleNet : 0;
        const tax = roundMoney(net * effectiveRate);
        const gross = roundMoney(net + tax);
        if (!(gross > 0)) return { error: "zero_amount" };

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

        // ⚠ نفس تقريب الإرجاع السريع أعلاه: لا ربط مخزَّن بين سطر البيع
        // ووحدة item_units بعينها — تُعاد أي N وحدة مباعة من نفس الصنف.
        // القطعة التالفة تعود لغير مباعة (sold=false) لكن غير قابلة
        // للعرض حتى تُفحص — issued=true يمنع بيعها ثانية بلا فحص، مطابقةً
        // لمعنى sellable=false في المرجع (لا عمود منفصل لهذا في الباك
        // إند، وissued هو الأقرب لغرضه: "خارج تداول البيع العادي").
        for (const l of returnedLines) {
          const { rows: soldUnits } = await client.query(
            `select id from item_units where item_id = $1 and sold = true order by code limit $2`,
            [l.item_id, l.quantity]
          );
          if (soldUnits.length < l.quantity) {
            return { error: "unit_mismatch", itemId: l.item_id, available: soldUnits.length, requested: l.quantity };
          }
          const ids = soldUnits.map((r) => r.id);
          if (restock === "damaged") {
            await client.query(`update item_units set sold = false, issued = true where id = any($1::uuid[])`, [ids]);
          } else {
            await client.query(`update item_units set sold = false where id = any($1::uuid[])`, [ids]);
          }
        }

        const businessDayId = sale.business_day_id;
        const { rows: refRows } = await client.query(
          `select count(*)::int + 1 as n from returns where branch_id = $1`,
          [req.auth.branchId]
        );
        const ref = `RTN-${String(refRows[0].n).padStart(6, "0")}`;
        const totalWeight = [...weightByKarat.values()].reduce((a, w) => a + w, 0);

        const { rows: retRows } = await client.query(
          `insert into returns
             (branch_id, ref, sale_id, business_day_id, amount, weight, reason,
              line_indexes, lines, full_return, refund_source, customer_id, customer_name, created_by)
           values ($1,$2,$3,$4,$5,$6,$7, $8,$9,$10,$11,$12,$13,$14)
           returning *`,
          [
            req.auth.branchId, ref, sale.id, businessDayId, gross, totalWeight, body.note || null,
            JSON.stringify(lineIndexes), JSON.stringify(returnedLines), lineIndexes.length === allLines.length,
            refundTarget, sale.customer_id, sale.customer_name, req.auth.userId,
          ]
        );
        const returnRec = retRows[0];

        // ── دفتر الوزن: الذهب يعود للمخزون (1210) ──
        for (const [karat, weight] of weightByKarat) {
          await client.query(
            `insert into gold_ledger_entries
               (branch_id, business_day_id, op_type, karat, weight, fine_weight,
                from_account, to_account, ref_table, ref_id, note, created_by)
             values ($1,$2,'sale_return',$3,$4,$5, null,'1210', 'returns',$6,$7,$8)`,
            [req.auth.branchId, businessDayId, karat, weight, fineWeight(weight, karat), returnRec.id, `مرتجع ${sale.ref}`, req.auth.userId]
          );
        }

        // ── القيد المزدوج الكامل: عكس البيع + عكس التكلفة في قيد واحد ──
        const lines = [];
        if (net > 0) lines.push({ account: "4190", side: "debit", amount: net });
        if (tax > 0) lines.push({ account: "2220", side: "debit", amount: tax });
        lines.push({ account: REFUND_TARGET_ACCOUNTS[refundTarget], side: "credit", amount: gross });
        if (cost > 0) {
          lines.push({ account: "1200", side: "debit", amount: cost });
          lines.push({ account: "5100", side: "credit", amount: cost });
        }
        const journalEntryId = await postJournalEntry(client, {
          branchId: req.auth.branchId, businessDayId, opType: "sale_return",
          refTable: "returns", refId: returnRec.id,
          description: `مرتجع مبيعات — ${sale.ref}`, createdBy: req.auth.userId, lines,
        });

        // ── حركة النقد/الذمم الفعلية ──
        let receiptRec = null;
        let cashResult = null;
        if (refundTarget === "credit") {
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
              req.auth.branchId, receiptRef, sale.customer_id, sale.customer_name, sale.id, -gross,
              `خصم مرتجع ${ref}`, businessDayId, req.auth.userId,
            ]
          );
          receiptRec = rcRows[0];
        } else {
          cashResult = await moveCash(client, {
            branchId: req.auth.branchId, businessDayId, direction: "out",
            sourceId: REFUND_TARGET_CASH_SOURCE[refundTarget], amount: gross, category: "sales_return",
            note: `مرتجع ${ref} — ${sale.ref}`,
            refTable: "returns", refId: returnRec.id, createdBy: req.auth.userId,
          });
        }

        return {
          return: { ...returnRec, restock, journalEntryId },
          receipt: receiptRec,
          cashTx: cashResult?.cashTx || null,
          amounts: { net, tax, gross, cost },
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
