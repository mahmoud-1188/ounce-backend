import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requirePage, requireManager } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { roundWeight, PURITY, fineWeight } from "../domain/weight.js";
import { postJournalEntry } from "../domain/journal.js";

const router = Router();

/**
 * التثبيت — ذهب ↔ نقد (migration 018).
 *
 * ⚠ ميزة جديدة فعليًا لا تفعيل سقالة ميتة (خلاف 015/016/017): لا
 * PriceFixPage ولا computeFix ولا FIX_KINDS لهما أي وجود سابق في تطبيقنا
 * — لا في الفرونت إند ولا في الباك إند. راجع تعليق migration 018 لتفصيل
 * القرار المحاسبي (مقاصة مباشرة 1220↔1110/1120 بلا حساب ربح/خسارة، بعد
 * سؤالك صراحةً، لأن لا تكلفة متتبَّعة لذهب الخزنة أصلًا في قاعدتنا ولا في
 * المرجع الذي ترك هذه النقطة تحديدًا غير مكتملة).
 *
 * ⚠ عملية واحدة تُقيَّد في دفترين معًا داخل معاملة واحدة (withBranch):
 * الدفتر الوزني (safe_gold_tx + gold_ledger_entries) والدفتر النقدي
 * (cash_tx + journal_entries/journal_lines). فشل أي منهما يُسقِط الآخر
 * تلقائيًّا (rollback عبر withBranch) — تمامًا كتحذير المرجع: "أحدهما بلا
 * الآخر يجعل ذهبًا يختفي أو نقدًا يظهر من لا شيء".
 */
router.use("/price-fix", authenticate, requirePage("priceFix"));

async function openDay(client, branchId) {
  const { rows } = await client.query(
    `select id from business_days where branch_id = $1 and status = 'open'
       order by opened_at desc limit 1`,
    [branchId]
  );
  return rows[0]?.id || null;
}

// حسابات النقد حسب مصدر التمويل — نفس CASH_ACCOUNTS في payroll.routes.js/
// purchases.routes.js/expenses.routes.js، هنا فقط اثنان (نقدي/شبكة) لأن
// التثبيت من/إلى خزنة المحل حصرًا، لا الصندوق اليومي ولا عهدة الكسر —
// تمامًا كحال PriceFixPage المرجعي الذي يقرأ/يكتب safeTx فقط.
const CASH_ACCOUNTS = {
  safe_cash: { account: "1110", method: "cash" },
  safe_network: { account: "1120", method: "network" },
};

/**
 * GET /api/price-fix — سجل التثبيتات + رصيد الخزنة الحالي (ذهب معادل 24 +
 * نقد)، مطابقةً لما تعرضه PriceFixPage المرجعية أعلى الشاشة.
 */
router.get("/price-fix", async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const { rows: fixes } = await client.query(
        `select * from price_fixes where branch_id = $1 order by created_at desc limit 200`,
        [req.auth.branchId]
      );
      const { rows: goldRows } = await client.query(
        `select karat,
                coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as balance
           from safe_gold_tx where branch_id = $1
          group by karat`,
        [req.auth.branchId]
      );
      const { rows: cashRows } = await client.query(
        `select method,
                coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
           from cash_tx where branch_id = $1 and pool = 'safe'
          group by method`,
        [req.auth.branchId]
      );
      const goldFine24 = goldRows.reduce(
        (a, r) => a + Number(r.balance) * (PURITY[r.karat] || Number(r.karat) / 24), 0
      );
      const cashCash = Number(cashRows.find((r) => r.method === "cash")?.balance) || 0;
      const cashNetwork = Number(cashRows.find((r) => r.method === "network")?.balance) || 0;
      return {
        fixes,
        safeGoldFine24: roundWeight(goldFine24),
        safeCash: roundMoney(cashCash),
        safeNetwork: roundMoney(cashNetwork),
      };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/price-fix
 * body: { kind: 'gold_to_cash'|'cash_to_gold', weight24?, cashAmount?,
 *         price24, fundingSource: 'safe_cash'|'safe_network', karat?, note? }
 *
 * أحد weight24/cashAmount لا كليهما — يُشتقّ الآخر من السعر، مطابقةً
 * لـcomputeFix المرجعي حرفيًا (منع إدخال متناقض: 20 جم بـ10,000 وسعر
 * الجرام 400 = 8,000 لا يتوافقان).
 */
router.post("/price-fix", requireManager, async (req, res, next) => {
  const body = req.body || {};
  const kind = body.kind;
  const price24 = Number(body.price24) || 0;
  const weight24In = Number(body.weight24) || 0;
  const cashAmountIn = Number(body.cashAmount) || 0;
  const karat = Number(body.karat) || 24;
  const fundingSource = body.fundingSource;
  const note = body.note ? String(body.note).trim() : null;

  if (kind !== "gold_to_cash" && kind !== "cash_to_gold") {
    return res.status(400).json({ error: "invalid_kind" });
  }
  if (price24 <= 0) {
    return res.status(400).json({ error: "price_required" });
  }
  if (weight24In > 0 && cashAmountIn > 0) {
    return res.status(400).json({ error: "weight_or_cash_only" });
  }
  if (weight24In <= 0 && cashAmountIn <= 0) {
    return res.status(400).json({ error: "weight_or_cash_required" });
  }
  const cashAcc = CASH_ACCOUNTS[fundingSource];
  if (!cashAcc) {
    return res.status(400).json({ error: "invalid_funding_source" });
  }
  if (!PURITY[karat]) {
    return res.status(400).json({ error: "invalid_karat" });
  }

  // نفس اشتقاق computeFix المرجعي: من الوزن يُحسب المبلغ، أو العكس.
  const weight24 = weight24In > 0 ? roundWeight(weight24In) : roundWeight(cashAmountIn / price24);
  const cashAmount = weight24In > 0 ? roundMoney(weight24In * price24) : roundMoney(cashAmountIn);
  if (weight24 <= 0 || cashAmount <= 0) {
    return res.status(400).json({ error: "invalid_amount" });
  }

  const goldDir = kind === "gold_to_cash" ? "out" : "in";
  const cashDir = kind === "gold_to_cash" ? "in" : "out";
  const label = kind === "gold_to_cash" ? "تثبيت ذهب → نقد" : "تثبيت نقد → ذهب";

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const businessDayId = await openDay(client, req.auth.branchId);
      if (!businessDayId) return { error: "day_not_open" };

      // ── الرصيد يكفي؟ (مطابقةً لتحقق handlePriceFix المرجعي) ──
      const { rows: goldRows } = await client.query(
        `select karat,
                coalesce(sum(case when direction = 'in' then weight else -weight end), 0) as balance
           from safe_gold_tx where branch_id = $1
          group by karat`,
        [req.auth.branchId]
      );
      const goldNow = goldRows.reduce(
        (a, r) => a + Number(r.balance) * (PURITY[r.karat] || Number(r.karat) / 24), 0
      );
      if (kind === "gold_to_cash" && weight24 > goldNow + 0.0005) {
        return { error: "insufficient_gold", available: roundWeight(goldNow) };
      }
      if (kind === "cash_to_gold") {
        const { rows: cashRows } = await client.query(
          `select coalesce(sum(case when direction = 'in' then amount else -amount end), 0) as balance
             from cash_tx where branch_id = $1 and pool = 'safe' and method = $2`,
          [req.auth.branchId, cashAcc.method]
        );
        const cashNow = Number(cashRows[0]?.balance) || 0;
        if (cashAmount > cashNow + 0.005) {
          return { error: "insufficient_cash", available: roundMoney(cashNow) };
        }
      }

      // مرجع تسلسلي بسيط — يكفي لعرض السجل، مطابقةً لنمط ref في كل مسار
      // آخر (purchases/sales/…): بادئة + رقم تسلسلي داخل الفرع.
      const { rows: refRows } = await client.query(
        `select count(*)::int + 1 as n from price_fixes where branch_id = $1`,
        [req.auth.branchId]
      );
      const ref = `FIX-${String(refRows[0].n).padStart(4, "0")}`;

      // الوزن الفعلي بعياره (لا معادل 24) — يُخزَّن في safe_gold_tx كما
      // يُخزَّن أي وزن آخر هناك (وزن حقيقي بعيار، لا معادل).
      const rawWeight = roundWeight(weight24 / PURITY[karat]);

      const { rows: fixRows } = await client.query(
        `insert into price_fixes
           (branch_id, business_day_id, ref, kind, karat, weight_24k, cash_amount, price24,
            funding_source, note, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning *`,
        [req.auth.branchId, businessDayId, ref, kind, karat, weight24, cashAmount, price24,
          fundingSource, note, req.auth.userId]
      );
      const fixId = fixRows[0].id;

      // ── الدفتر الوزني ──
      await client.query(
        `insert into safe_gold_tx
           (branch_id, business_day_id, direction, karat, weight, kind, destination, note, created_by,
            ref_table, ref_id)
         values ($1,$2,$3,$4,$5,'raw',$6,$7,$8,'price_fixes',$9)`,
        [req.auth.branchId, businessDayId, goldDir, karat, rawWeight,
          goldDir === "out" ? "price_fix" : null,
          `${label} · ${ref}${note ? " — " + note : ""}`, req.auth.userId, fixId]
      );
      await client.query(
        `insert into gold_ledger_entries
           (branch_id, business_day_id, op_type, karat, weight, fine_weight,
            from_account, to_account, ref_table, ref_id, note, created_by)
         values ($1,$2,$3,$4,$5,$6, $7,$8, 'price_fixes',$9,$10,$11)`,
        [req.auth.branchId, businessDayId, goldDir === "out" ? "price_fix_sell" : "price_fix_buy",
          karat, rawWeight, fineWeight(rawWeight, karat),
          goldDir === "out" ? "1220" : null, goldDir === "out" ? null : "1220",
          fixId, `${label} · ${ref}`, req.auth.userId]
      );

      // ── الدفتر النقدي ──
      await client.query(
        `insert into cash_tx
           (branch_id, business_day_id, pool, method, direction, amount, category, note,
            ref_table, ref_id, created_by)
         values ($1,$2,'safe',$3,$4,$5,'price_fix',$6,'price_fixes',$7,$8)`,
        [req.auth.branchId, businessDayId, cashAcc.method, cashDir, cashAmount,
          `${label} · ${ref}${note ? " — " + note : ""}`, fixId, req.auth.userId]
      );
      await postJournalEntry(client, {
        branchId: req.auth.branchId,
        businessDayId,
        opType: kind === "gold_to_cash" ? "price_fix_sell" : "price_fix_buy",
        refTable: "price_fixes",
        refId: fixId,
        description: `${label} · ${ref} · ${weight24} جم24 × ${price24}`,
        createdBy: req.auth.userId,
        lines: [
          { account: cashAcc.account, side: cashDir === "in" ? "debit" : "credit", amount: cashAmount },
          { account: "1220", side: goldDir === "out" ? "credit" : "debit", amount: cashAmount },
        ],
      });

      return { fix: fixRows[0] };
    });
    if (result.error) {
      const status = result.error === "day_not_open" ? 400
        : result.error.startsWith("insufficient") ? 409 : 400;
      return res.status(status).json(result);
    }
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
