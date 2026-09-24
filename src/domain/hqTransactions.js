import { fineWeight } from "./weight.js";
import { postJournalEntry } from "./journal.js";

/**
 * سجلّ "معاملات الإدارة" — نظير HQ_FLOWS في المرجع، لكن مصدر حقيقةٍ
 * خادميّ واحد (لا يتكرّر في الفرونت): الفرونت (ounce-central/
 * ounce-frontend) يعرض label فقط مما يرجعه الـAPI، لا ينسخ هذه القائمة.
 *
 * dir: من يبدأ المعاملة دائمًا — "branch" لخمسةٍ من الستة، و"hq" لواحدة
 * فقط (goods_from_hq). راجع تعليق 027_hq_transactions.sql لسبب عدم
 * تخزين هذا كعمود قاعدة بيانات.
 *
 * needs: الحقول الإلزامية لإنشاء هذا النوع — نفس needs في HQ_FLOWS
 * بالمرجع بالضبط.
 */
const HQ_FLOWS = {
  purchase_request: { label: "طلب شراء", dir: "branch", needs: ["weight", "karat"] },
  goods_to_hq: { label: "تسليم بضاعة للإدارة", dir: "branch", needs: ["weight", "karat", "pieces"] },
  goods_from_hq: { label: "استلام بضاعة من الإدارة", dir: "hq", needs: ["weight", "karat", "pieces"] },
  send_for_coding: { label: "إرسال للتكويد في الإدارة", dir: "branch", needs: ["weight", "karat", "pieces"] },
  taskir_to_hq: { label: "تسكير عبر الإدارة", dir: "branch", needs: ["weight", "karat"] },
  cash_transfer: { label: "تحويل نقدي للإدارة", dir: "branch", needs: ["amount"] },
  // migration 041: نقدٌ من خزنة الإدارة (أو فرعٍ مصدر) إلى خزنة الفرع — بقيدٍ على الطرفين
  cash_from_hq: { label: "تحويل نقد من الإدارة", dir: "hq", needs: ["amount"] },
};

const FIELD_LABEL = { weight: "الوزن", karat: "العيار", pieces: "عدد القطع", amount: "المبلغ" };

/**
 * ⚠ من يستلم فعليًّا عند اكتمال كل نوع — يحدّد أي مسار (فرع أو مركزي)
 * يملك صلاحية استدعاء "استلام" لهذه المعاملة بعد اعتمادها:
 *   • hq: بضاعة/نقدٌ خرج من الفرع، والإدارة من تستلمه فعليًّا
 *     (goods_to_hq, taskir_to_hq, cash_transfer).
 *   • branch: بضاعةٌ قادمة من الإدارة أو عائدة من التكويد، والفرع من
 *     يستلمها فعليًّا (goods_from_hq, send_for_coding).
 *   • null: لا خطوة "استلام" لهذا النوع أصلًا (purchase_request —
 *     تُستهلك موافقته بدل ذلك، راجع consumeApprovedPurchaseRequest).
 */
const RECEIVER_SIDE = {
  purchase_request: null,
  goods_to_hq: "hq",
  goods_from_hq: "branch",
  send_for_coding: "branch",
  taskir_to_hq: "hq",
  cash_transfer: "hq",
  cash_from_hq: "branch",
};

function validateHqTransactionFields(flow, { weight, karat, pieces, amount }) {
  const rule = HQ_FLOWS[flow];
  if (!rule) return { error: "unknown_flow" };
  for (const need of rule.needs) {
    const v = { weight, karat, pieces, amount }[need];
    if (!(Number(v) > 0)) {
      return { error: "missing_field", field: need, fieldLabel: FIELD_LABEL[need] };
    }
  }
  return { ok: true };
}

/**
 * يُرحّل استلام شحنة goods_from_hq فعليًّا في مخزون الفرع — نظير
 * postWeight("branch_receive", ...) في المرجع بالضبط، لكن سطرًا واحدًا
 * بإجمالي الوزن (لا سطرًا لكل قطعة كالمرجع، إذ لا تفاصيل قطعٍ فردية في
 * هذه المعاملة أصلًا هنا بخلاف المرجع الذي يحمل مصفوفة عناصر كاملة).
 *
 * from: null، to: '1210' — تُعامَل كبضاعةٍ جديدة داخلة لجاهز البيع
 * مباشرةً (لا عكس قيدٍ سابق)، بالضبط كما يفعل المرجع (لا حساب "ذهب لدى
 * فروع أخرى" وسيطًا هنا — الشحنة تصل مُكوَّدة جاهزة للبيع فورًا).
 *
 * ⚠ سطر وزنٍ فقط (gold_ledger_entries) بلا قيدٍ محاسبي مزدوج
 * (journal_entries) — نفس نمط دفتري الفرع الحاليين تمامًا: حركة الوزن
 * (جرام بعيار) ودفتر اليومية المالي (ريال) منفصلان دومًا في هذا
 * التطبيق (قارن بمسار الشراء في purchases.routes.js: سطر
 * gold_ledger_entries للوزن يُدرَج بلا postJournalEntry مرافق؛
 * postJournalEntry هناك يُستدعى فقط لجانب السداد النقدي، لا للوزن).
 * لا قيمة نقدية تُحتسب لهذه الشحنة هنا لنفس السبب الذي لم يحتسبها به
 * المرجع نفسه.
 */
async function postGoodsFromHqReceipt(client, { branchId, businessDayId, txn, userId }) {
  await client.query(
    `insert into gold_ledger_entries
       (branch_id, business_day_id, op_type, karat, weight, fine_weight,
        from_account, to_account, ref_table, ref_id, note, created_by)
     values ($1,$2,'hq_transaction_receive',$3,$4,$5, null,'1210', 'hq_transactions',$6,$7,$8)`,
    [
      branchId, businessDayId, txn.karat, txn.weight, fineWeight(txn.weight, txn.karat),
      txn.id, `استلام شحنة من الإدارة — ${txn.pieces || ""} قطعة`.trim(), userId,
    ]
  );
}

/** رصيد النقد في خزنة فرع (safe/cash) من حركاتها. */
async function safeCashBalance(client, branchId) {
  const { rows } = await client.query(
    `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as b
       from cash_tx where branch_id = $1 and pool = 'safe' and method = 'cash'`,
    [branchId]
  );
  return Number(rows[0].b) || 0;
}

async function openDayId(client, branchId) {
  const { rows } = await client.query(
    "select id from business_days where branch_id = $1 and status = 'open' order by opened_at desc limit 1",
    [branchId]
  );
  return rows[0]?.id || null;
}

/**
 * طرف الإرسال في تحويل نقدٍ من الإدارة: يخرج من خزنة المصدر نقدًا إلى
 * «نقدٌ في الطريق» (1160) — المرجع: deductFromSource + postJournal("branch_cash_out").
 * يُستدعى داخل withBranch(fromBranchId).
 */
async function postCashFromHqSend(client, { fromBranchId, txnId, amount, toName, note, actorName }) {
  const day = await openDayId(client, fromBranchId);
  const label = `تحويل نقد إلى ${toName}${note ? ` · ${note}` : ""}`;
  await client.query(
    `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note)
     values ($1,$2,'safe','cash','out',$3,'branch_cash_out','hq_transactions',$4,$5)`,
    [fromBranchId, day, amount, txnId, label]
  );
  await postJournalEntry(client, {
    branchId: fromBranchId, businessDayId: day, opType: "branch_cash_out", refTable: "hq_transactions", refId: txnId,
    description: `${label} — من الإدارة (${actorName})`, createdBy: null,
    lines: [{ account: "1160", side: "debit", amount }, { account: "1110", side: "credit", amount }],
  });
}

/** طرف الاستلام: يدخل خزنة الفرع نقدًا من «نقدٌ في الطريق» — المرجع: branch_cash_in. */
async function postCashFromHqReceipt(client, { branchId, txn, userId, userName }) {
  const day = await openDayId(client, branchId);
  const amount = Number(txn.amount);
  const label = `استلام نقد من الإدارة${txn.note ? ` · ${txn.note}` : ""}`;
  await client.query(
    `insert into cash_tx (branch_id, business_day_id, pool, method, direction, amount, category, ref_table, ref_id, note, created_by)
     values ($1,$2,'safe','cash','in',$3,'branch_cash_in','hq_transactions',$4,$5,$6)`,
    [branchId, day, amount, txn.id, label, userId]
  );
  await postJournalEntry(client, {
    branchId, businessDayId: day, opType: "branch_cash_in", refTable: "hq_transactions", refId: txn.id,
    description: `${label}${userName ? ` — استلمه ${userName}` : ""}`, createdBy: userId,
    lines: [{ account: "1110", side: "debit", amount }, { account: "1160", side: "credit", amount }],
  });
}

export { HQ_FLOWS, RECEIVER_SIDE, validateHqTransactionFields, postGoodsFromHqReceipt, safeCashBalance, postCashFromHqSend, postCashFromHqReceipt };
