import { fineWeight } from "./weight.js";

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

export { HQ_FLOWS, RECEIVER_SIDE, validateHqTransactionFields, postGoodsFromHqReceipt };
