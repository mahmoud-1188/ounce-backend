import { Router } from "express";
import { withoutBranch } from "../db.js";
import { authenticate, requirePage } from "../middleware/auth.js";
import { PURITY } from "../domain/weight.js";

const router = Router();

/**
 * تقرير "الإدارة/متعدد الفروع" — migration 017.
 *
 * ⚠ ميزة جديدة فعليًا، لا تفعيل سقالة ميتة بالمعنى المعتاد (قارن بـ015/
 * 016): hq_permissions/branches.is_hq موجودان في schema.sql لكن
 * HqTransactionsPage.js المرجعي شيء آخر تمامًا — مزامنة يدوية بين نسخ
 * محلية منفصلة عبر رمز موقَّع يُلصق ويُرسَل واتساب (لا خادم مشترك في
 * المرجع أصلًا). تطبيقنا يملك قاعدة بيانات واحدة حقيقية تخدم كل الفروع
 * فعليًا، فالمعنى العملي لـ"تقرير الإدارة" هنا هو تجميع مباشر من نفس
 * القاعدة عبر SQL، لا محاكاة مزامنة الرموز.
 *
 * القرار (سؤال المستخدم صراحةً — راجع محادثة إضافة هذا الملف):
 *   • من يرى التقرير؟ فرع واحد فقط مُعلَّم branches.is_hq = true (عملية
 *     تشغيلية تُجرى يدويًّا على القاعدة، لا واجهة تمنحها) — أي مستخدم
 *     manager في ذلك الفرع تحديدًا. هذا التحقق يجري هنا صراحةً (لا يكفي
 *     requirePage وحده) لأن withoutBranch أدناه يتجاوز عزل RLS عمدًا.
 *   • ما النطاق؟ ملخصات مجمّعة فقط لكل فرع — بلا تفاصيل سجلات فردية.
 *
 * ⚠ withoutBranch هو المسار الوحيد في كل الباك إند الذي يتجاوز عزل
 * الفروع عمدًا. حمايته الوحيدة هي فحص is_hq يدويًّا أدناه قبل أي استعلام
 * — أي تعديل هنا يجب أن يُبقي هذا الفحص أول خطوة دائمًا.
 */
router.use("/hq", authenticate, requirePage("hqReports"));

async function assertHqBranch(req) {
  const { rows } = await withoutBranch((client) =>
    client.query(`select is_hq from branches where id = $1`, [req.auth.branchId])
  );
  return !!rows[0]?.is_hq;
}

/**
 * GET /api/hq/report?period=YYYY-MM
 *
 * period اختياري (افتراضه الشهر الحالي) ويحدّد فقط نافذة المبيعات/
 * المشتريات (تدفّق)؛ أرصدة المخزون/الخزنة/الذمم أرقام "حتى الآن" (رصيد)
 * لا فرق فيها للفترة — تمامًا كيف تُعرض كل شاشة رصيد أخرى في التطبيق
 * (خزنة، مخزون) بلا فلترة بفترة.
 */
router.get("/hq/report", async (req, res, next) => {
  try {
    const isHq = await assertHqBranch(req);
    if (!isHq) {
      return res.status(403).json({ error: "not_hq_branch" });
    }

    const period = /^\d{4}-\d{2}$/.test(req.query.period || "")
      ? req.query.period
      : new Date().toISOString().slice(0, 7);
    const periodStart = `${period}-01`;

    const report = await withoutBranch(async (client) => {
      const { rows: branches } = await client.query(
        `select id, ref, name from branches order by name`
      );
      if (!branches.length) return { period, branches: [] };
      const branchIds = branches.map((b) => b.id);

      // مبيعات الفترة: إجمالي، صافٍ (بعد الضريبة)، عدد الفواتير — لكل فرع.
      const { rows: salesRows } = await client.query(
        `select branch_id,
                count(*)::int as sales_count,
                coalesce(sum(total), 0) as sales_total,
                coalesce(sum(net_amount), 0) as sales_net
           from sales
          where branch_id = any($1)
            and date >= $2::date and date < ($2::date + interval '1 month')
          group by branch_id`,
        [branchIds, periodStart]
      );

      // مشتريات الفترة (وزن ذهب داخل عبر lots — من جدول lots كما تُبنى
      // شاشة المشتريات الحالية: تكلفة اللوت الإجمالية + وزنه).
      const { rows: purchaseRows } = await client.query(
        `select branch_id,
                count(*)::int as purchases_count,
                coalesce(sum(weight), 0) as purchases_weight,
                coalesce(sum(weight * cost_per_gram), 0) as purchases_cost
           from lots
          where branch_id = any($1)
            and date_added >= $2::date and date_added < ($2::date + interval '1 month')
          group by branch_id`,
        [branchIds, periodStart]
      );

      // مخزون قائم (غير مُباع) لكل فرع، مجمّعًا للوزن المعادل عيار 24
      // وتكلفته — بنفس منطق PURITY المستخدم في كل الحسابات الأخرى.
      const { rows: itemRows } = await client.query(
        `select i.branch_id, i.karat, i.weight, i.cost_per_gram, i.workmanship
           from items i
           join item_units u on u.item_id = i.id
          where i.branch_id = any($1) and u.sold = false`,
        [branchIds]
      );

      // رصيد الخزنة نقدًا/شبكة لكل فرع.
      const { rows: safeCashRows } = await client.query(
        `select branch_id, method,
                coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
           from cash_tx
          where branch_id = any($1) and pool = 'safe'
          group by branch_id, method`,
        [branchIds]
      );

      // رصيد ذهب الخزنة لكل فرع (معادل 24).
      const { rows: safeGoldRows } = await client.query(
        `select branch_id, karat,
                coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as balance
           from safe_gold_tx
          where branch_id = any($1)
          group by branch_id, karat`,
        [branchIds]
      );

      // ذمم مدينة (عملاء آجل، حساب 1310) وذمم دائنة (موردون، 2110) —
      // من journal_lines (لا branch_id فيها مباشرة — عبر الانضمام لـ
      // journal_entries التي تحمله) بنفس منهج رصيد أي حساب في هذا الباك
      // إند: مجموع مدين ناقص دائن للحسابات المدينة بطبيعتها والعكس للدائنة.
      const { rows: balanceRows } = await client.query(
        `select e.branch_id, l.account_code,
                coalesce(sum(case when l.side = 'debit' then l.amount else -l.amount end), 0) as balance
           from journal_lines l
           join journal_entries e on e.id = l.entry_id
          where e.branch_id = any($1) and l.account_code in ('1310', '2110')
          group by e.branch_id, l.account_code`,
        [branchIds]
      );

      const byBranch = new Map(
        branches.map((b) => [
          b.id,
          {
            branchId: b.id,
            branchRef: b.ref,
            branchName: b.name,
            sales: { count: 0, total: 0, net: 0 },
            purchases: { count: 0, weight: 0, cost: 0 },
            inventory: { fineWeight: 0, cost: 0 },
            safe: { cash: 0, network: 0, goldFineWeight: 0 },
            receivable: 0,
            payable: 0,
          },
        ])
      );

      for (const r of salesRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        b.sales = { count: r.sales_count, total: Number(r.sales_total), net: Number(r.sales_net) };
      }
      for (const r of purchaseRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        b.purchases = {
          count: r.purchases_count,
          weight: Number(r.purchases_weight),
          cost: Number(r.purchases_cost),
        };
      }
      for (const r of itemRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        const purity = PURITY[r.karat] || Number(r.karat) / 24;
        const weight = Number(r.weight) || 0;
        b.inventory.fineWeight += weight * purity;
        b.inventory.cost += weight * (Number(r.cost_per_gram) || 0) + (Number(r.workmanship) || 0);
      }
      for (const r of safeCashRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        if (r.method === "cash") b.safe.cash = Number(r.balance);
        else if (r.method === "network") b.safe.network = Number(r.balance);
      }
      for (const r of safeGoldRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        const purity = PURITY[r.karat] || Number(r.karat) / 24;
        b.safe.goldFineWeight += Number(r.balance) * purity;
      }
      for (const r of balanceRows) {
        const b = byBranch.get(r.branch_id);
        if (!b) continue;
        if (r.account_code === "1310") b.receivable = Number(r.balance);
        else if (r.account_code === "2110") b.payable = -Number(r.balance); // دائن بطبيعته: نعكس الإشارة لعرضه رقمًا موجبًا
      }

      const rows = branches.map((b) => byBranch.get(b.id));
      const totals = rows.reduce(
        (acc, b) => {
          acc.salesTotal += b.sales.total;
          acc.salesNet += b.sales.net;
          acc.purchasesCost += b.purchases.cost;
          acc.inventoryFineWeight += b.inventory.fineWeight;
          acc.inventoryCost += b.inventory.cost;
          acc.safeCash += b.safe.cash;
          acc.safeNetwork += b.safe.network;
          acc.safeGoldFineWeight += b.safe.goldFineWeight;
          acc.receivable += b.receivable;
          acc.payable += b.payable;
          return acc;
        },
        {
          salesTotal: 0, salesNet: 0, purchasesCost: 0,
          inventoryFineWeight: 0, inventoryCost: 0,
          safeCash: 0, safeNetwork: 0, safeGoldFineWeight: 0,
          receivable: 0, payable: 0,
        }
      );

      return { period, branches: rows, totals };
    });

    res.json(report);
  } catch (err) {
    next(err);
  }
});

export default router;
