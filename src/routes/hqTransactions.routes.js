import { Router } from "express";
import { withBranch, withoutBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import { authenticateStore, requireCanManageBranches, requireCanSendCoding } from "../middleware/storeAuth.js";
import { HQ_FLOWS, RECEIVER_SIDE, validateHqTransactionFields, postGoodsFromHqReceipt } from "../domain/hqTransactions.js";

const router = Router();

/**
 * "معاملات الإدارة" (hqDocs) — راجع 027_hq_transactions.sql للسبب
 * الكامل ولماذا اثنان فقط من الأنواع الستة يُرحّلان قيدًا تلقائيًّا.
 *
 * ⚠ نطاقٌ متعمَّد لم يُبنَ هنا: purchase_request بعد اعتمادها لا تُفرض
 * تلقائيًّا على مسار /purchases الحالي (لا تعديل على purchases.routes.js
 * في هذه الدفعة) — القرار سياسيّ (هل كل شراءٍ يحتاج موافقةً مسبقة؟ فوق
 * أي مبلغ؟ لكل الفروع أم بعضها؟) لم يُطرح بعد، فبناؤه بتخمين كان
 * سيُغيّر سلوك الشراء الحالي لكل الفروع بلا تفويضٍ صريح. هذه الدفعة
 * تبني الرؤية والاعتماد فقط؛ عمودا consumed_at/consumed_by جاهزان في
 * الجدول متى طُلب الربط الفعلي لاحقًا.
 */

const RECEIVE_REQUIRES_APPROVAL = new Set(
  Object.keys(HQ_FLOWS).filter((f) => f !== "goods_from_hq")
);

function serializeTxn(row) {
  const rule = HQ_FLOWS[row.flow];
  return {
    id: row.id,
    flow: row.flow,
    flowLabel: rule?.label || row.flow,
    dir: rule?.dir || null,
    status: row.status,
    weight: row.weight,
    karat: row.karat,
    fineWeight: row.fine_weight,
    pieces: row.pieces,
    amount: row.amount,
    note: row.note,
    branchId: row.branch_id,
    branchName: row.branch_name,
    branchRef: row.branch_ref,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    receivedAt: row.received_at,
    createdAt: row.created_at,
  };
}

// ═══════════════════════════════ جانب الفرع ═══════════════════════════════

router.use("/branch/hq-transactions", authenticate, requirePage("hqDocs"));

/** GET /api/branch/hq-transactions — كل معاملات هذا الفرع، الأحدث أولًا. */
router.get("/branch/hq-transactions", async (req, res, next) => {
  try {
    const rows = await withBranch(req.auth.branchId, (client) =>
      client
        .query(
          `select * from hq_transactions where branch_id = $1 order by created_at desc limit 200`,
          [req.auth.branchId]
        )
        .then((r) => r.rows)
    );
    res.json(rows.map(serializeTxn));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/branch/hq-transactions  { flow, weight?, karat?, pieces?, amount?, note? }
 * ⚠ الفرع يبدأ خمسة من الأنواع الستة فقط — goods_from_hq تبدؤها الإدارة
 * حصرًا (راجع POST /store/hq-transactions أدناه).
 */
router.post("/branch/hq-transactions", async (req, res, next) => {
  const { flow, weight, karat, pieces, amount, note } = req.body || {};
  const rule = HQ_FLOWS[flow];
  if (!rule) return res.status(400).json({ error: "unknown_flow" });
  if (rule.dir !== "branch") {
    return res.status(403).json({ error: "flow_not_branch_initiated" });
  }
  const check = validateHqTransactionFields(flow, { weight, karat, pieces, amount });
  if (check.error) return res.status(400).json(check);

  try {
    const { rows } = await withBranch(req.auth.branchId, (client) =>
      client.query(
        `insert into hq_transactions
           (branch_id, flow, weight, karat, fine_weight, pieces, amount, note, requested_by_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning *`,
        [
          req.auth.branchId, flow, weight || null, karat || null,
          weight && karat ? Number(weight) * (karat / 24) : null,
          pieces || null, amount || null, String(note || "").slice(0, 200) || null,
          req.auth.userId,
        ]
      )
    );
    res.status(201).json(serializeTxn(rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/branch/hq-transactions/:id/receive
 * يستلم الفرع (goods_from_hq، send_for_coding) — الوحيد الذي يُرحّل
 * قيدًا حقيقيًّا هو goods_from_hq (راجع postGoodsFromHqReceipt).
 */
router.post("/branch/hq-transactions/:id/receive", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows } = await client.query(
        `select * from hq_transactions where id = $1 and branch_id = $2`,
        [req.params.id, req.auth.branchId]
      );
      const txn = rows[0];
      if (!txn) return { notFound: true };
      if (RECEIVER_SIDE[txn.flow] !== "branch") {
        return { error: "not_branch_receivable" };
      }
      // ⚠ goods_from_hq تتخطى خطوة الاعتماد (الإدارة نفسها من أنشأتها —
      // لا معنى لاعتمادها لنفسها)، فتُستلم من pending مباشرةً. غيرها
      // (send_for_coding) يحتاج اعتماد الإدارة أولًا.
      const requiresApproval = RECEIVE_REQUIRES_APPROVAL.has(txn.flow);
      if (requiresApproval && txn.status !== "approved") {
        return { error: "not_approved_yet" };
      }
      if (!requiresApproval && txn.status !== "pending") {
        return { error: "already_" + txn.status };
      }

      const { rows: updated } = await client.query(
        `update hq_transactions
            set status = 'received', received_at = now(), received_by_user_id = $2
          where id = $1
          returning *`,
        [txn.id, req.auth.userId]
      );

      if (txn.flow === "goods_from_hq") {
        const { rows: dayRows } = await client.query(
          `select id from business_days where branch_id = $1 and status = 'open'
             order by opened_at desc limit 1`,
          [req.auth.branchId]
        );
        await postGoodsFromHqReceipt(client, {
          branchId: req.auth.branchId,
          businessDayId: dayRows[0]?.id || null,
          txn: updated[0],
          userId: req.auth.userId,
        });
      }
      return { txn: updated[0] };
    });

    if (result.notFound) return res.status(404).json({ error: "transaction_not_found" });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(serializeTxn(result.txn));
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════ جانب المركزي ═══════════════════════════════

async function assertBranchInStore(storeId, branchId) {
  const { rows } = await withoutBranch((client) =>
    client.query(
      `select 1 from branches where id = $1 and store_id = $2 and deleted_at is null`,
      [branchId, storeId]
    )
  );
  return !!rows[0];
}

router.use("/store/hq-transactions", authenticateStore);

/** GET /api/store/hq-transactions — كل معاملات فروع هذا المتجر. */
router.get("/store/hq-transactions", async (req, res, next) => {
  try {
    const rows = await withoutBranch((client) =>
      client
        .query(
          `select t.*, b.name as branch_name, b.ref as branch_ref
             from hq_transactions t
             join branches b on b.id = t.branch_id
            where b.store_id = $1 and b.deleted_at is null
            order by t.created_at desc
            limit 300`,
          [req.storeAuth.storeId]
        )
        .then((r) => r.rows)
    );
    res.json(rows.map(serializeTxn));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/store/hq-transactions  { branchId, weight, karat, pieces, note? }
 * تُنشئ الإدارة goods_from_hq فقط — النوع الوحيد الذي تبدؤه (شحنة
 * تكويد مُرسَلة لفرع). تتطلّب canSendCoding صراحةً (راجع
 * 026_store_user_coding_permission.sql) — رؤية شاشة "معاملات الإدارة"
 * لا تعني صلاحية إرسال بضاعة فعليًّا.
 */
router.post("/store/hq-transactions", requireCanSendCoding, async (req, res, next) => {
  const { branchId, weight, karat, pieces, note } = req.body || {};
  if (!branchId) return res.status(400).json({ error: "branch_id_required" });
  const check = validateHqTransactionFields("goods_from_hq", { weight, karat, pieces });
  if (check.error) return res.status(400).json(check);

  try {
    if (!(await assertBranchInStore(req.storeAuth.storeId, branchId))) {
      return res.status(404).json({ error: "branch_not_found" });
    }
    const { rows } = await withoutBranch((client) =>
      client.query(
        `insert into hq_transactions
           (branch_id, flow, weight, karat, fine_weight, pieces, note, requested_by_store_user_id)
         values ($1,'goods_from_hq',$2,$3,$4,$5,$6,$7)
         returning *`,
        [
          branchId, weight, karat, Number(weight) * (karat / 24), pieces,
          String(note || "").slice(0, 200) || null, req.storeAuth.storeUserId,
        ]
      )
    );
    res.status(201).json(serializeTxn(rows[0]));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/store/hq-transactions/:id/decide  { decision: 'approved'|'rejected', note? }
 * تعتمد/ترفض الإدارة معاملةً بدأها الفرع — canManageBranches (سلطة
 * إشراف مركزية عامة، لا صلاحية منفصلة لكل نوع معاملة على حدة).
 */
router.patch("/store/hq-transactions/:id/decide", requireCanManageBranches, async (req, res, next) => {
  const { decision, note } = req.body || {};
  if (decision !== "approved" && decision !== "rejected") {
    return res.status(400).json({ error: "invalid_decision" });
  }
  try {
    const result = await withoutBranch(async (client) => {
      const { rows } = await client.query(
        `select t.* from hq_transactions t
           join branches b on b.id = t.branch_id
          where t.id = $1 and b.store_id = $2`,
        [req.params.id, req.storeAuth.storeId]
      );
      const txn = rows[0];
      if (!txn) return { notFound: true };
      if (txn.flow === "goods_from_hq") return { error: "flow_has_no_decision_step" };
      if (txn.status !== "pending") return { error: "already_" + txn.status };

      const { rows: updated } = await client.query(
        `update hq_transactions
            set status = $2, decided_by_store_user_id = $3, decided_at = now(), decision_note = $4
          where id = $1
          returning *`,
        [txn.id, decision, req.storeAuth.storeUserId, String(note || "").slice(0, 200) || null]
      );
      return { txn: updated[0] };
    });

    if (result.notFound) return res.status(404).json({ error: "transaction_not_found" });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(serializeTxn(result.txn));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/store/hq-transactions/:id/receive
 * تستلم الإدارة (goods_to_hq, taskir_to_hq, cash_transfer) — بلا أي
 * ترحيل محاسبي تلقائي (راجع تعليق 027_hq_transactions.sql).
 */
router.post("/store/hq-transactions/:id/receive", requireCanManageBranches, async (req, res, next) => {
  try {
    const result = await withoutBranch(async (client) => {
      const { rows } = await client.query(
        `select t.* from hq_transactions t
           join branches b on b.id = t.branch_id
          where t.id = $1 and b.store_id = $2`,
        [req.params.id, req.storeAuth.storeId]
      );
      const txn = rows[0];
      if (!txn) return { notFound: true };
      if (RECEIVER_SIDE[txn.flow] !== "hq") return { error: "not_hq_receivable" };
      if (txn.status !== "approved") return { error: "not_approved_yet" };

      const { rows: updated } = await client.query(
        `update hq_transactions
            set status = 'received', received_at = now(), received_by_store_user_id = $2
          where id = $1
          returning *`,
        [txn.id, req.storeAuth.storeUserId]
      );
      return { txn: updated[0] };
    });

    if (result.notFound) return res.status(404).json({ error: "transaction_not_found" });
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(serializeTxn(result.txn));
  } catch (err) {
    next(err);
  }
});

export default router;
