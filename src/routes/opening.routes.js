import { Router } from "express";
import { withBranch } from "../db.js";
import { authenticate, requireManager, requireNotDenied, requirePage } from "../middleware/auth.js";
import { roundMoney } from "../domain/money.js";
import { getOpenBusinessDay, nextRef } from "../domain/saleOps.js";

const router = Router();

/**
 * وضع الافتتاح — محلٌّ جديد يُكوّد بضاعته القائمة بلا مورد (migration 035).
 *
 * ⚠ الدفعة الافتتاحية دفعةٌ حقيقية في lots (فتبقى كل قطعة مربوطةً بمصدرها
 *   كما يُلزم التكويد) لكن بلا مورد ولا وزنٍ مشترى ولا سداد: source='opening'.
 *   التكويد فيها (POST /lots/:id/items) يُرحّل الوزن إلى 1210 والقيمة
 *   1210/3100 لحظة التكويد — لا شيء يُرحَّل عند الإنهاء.
 *
 *   POST /opening/mode    { on }                          — مدير · الرصيد الافتتاحي
 *   POST /opening/lots    { karat, costPerGram, costRef }  — التكويد
 *   POST /opening/finish                                   — مدير · الرصيد الافتتاحي
 */

const OPENING_KARATS = [24, 22, 21, 18];

async function openingState(client, branchId) {
  const { rows } = await client.query(
    "select opening_mode, opening_finished_at from branch_settings where branch_id = $1",
    [branchId]
  );
  return { on: !!rows[0]?.opening_mode, finishedAt: rows[0]?.opening_finished_at || null };
}

async function openingStats(client, branchId) {
  const { rows } = await client.query(
    `select count(distinct l.id)::int as lots,
            count(distinct l.id) filter (where l.status = 'open')::int as open_lots,
            count(u.id)::int as pieces,
            coalesce(sum(i.weight) filter (where u.id is not null), 0) as weight,
            coalesce(sum(coalesce(i.cost_per_gram, 0) * i.weight + coalesce(i.workmanship, 0)) filter (where u.id is not null), 0) as value
       from lots l
       left join items i on i.lot_id = l.id
       left join item_units u on u.item_id = i.id
      where l.branch_id = $1 and l.source = 'opening'`,
    [branchId]
  );
  const r = rows[0] || {};
  return {
    lots: r.lots || 0,
    openLots: r.open_lots || 0,
    pieces: r.pieces || 0,
    weight: Math.round(Number(r.weight || 0) * 1000) / 1000,
    value: roundMoney(r.value),
  };
}

router.post("/opening/mode", authenticate, requirePage("openingBalance"), requireManager, async (req, res, next) => {
  const on = !!req.body?.on;
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      if (on) {
        // ⚠ للمحل الجديد قبل أول بيع: بضاعةٌ تُدخل رصيدًا افتتاحيًّا بعد أن
        //   باع المحل تخلط الافتتاح بالتشغيل.
        const { rows } = await client.query("select 1 from sales where branch_id = $1 limit 1", [req.auth.branchId]);
        if (rows.length) return { error: "branch_has_sales" };
      }
      await client.query(
        `insert into branch_settings (branch_id, opening_mode) values ($1, $2)
         on conflict (branch_id) do update set opening_mode = excluded.opening_mode`,
        [req.auth.branchId, on]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ openingMode: on })]
      );
      return { openingMode: on, stats: await openingStats(client, req.auth.branchId) };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/opening/lots", authenticate, requirePage("addGoods"), requireNotDenied("addGoods"), async (req, res, next) => {
  const body = req.body || {};
  const karat = Number(body.karat);
  const costPerGram = Number(body.costPerGram);
  const costRef = body.costRef === "market" ? "market" : "purchase";
  if (!OPENING_KARATS.includes(karat)) return res.status(400).json({ error: "invalid_karat" });
  if (!(costPerGram > 0)) return res.status(400).json({ error: "invalid_cost_per_gram" });

  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const state = await openingState(client, req.auth.branchId);
      if (!state.on) return { error: "opening_mode_off" };
      const day = await getOpenBusinessDay(client, req.auth.branchId);
      const { rows: nRows } = await client.query(
        "select count(*)::int + 1 as n from lots where branch_id = $1 and source = 'opening'",
        [req.auth.branchId]
      );
      const ref = `OPN-${String(nRows[0].n).padStart(3, "0")}`;
      const { rows } = await client.query(
        `insert into lots
           (branch_id, ref, supplier_id, date, created_by, karat, weight, cost_per_gram,
            gold_cost, workmanship_total, total_cost, status, source, cost_ref)
         values ($1,$2,null,current_date,$3,$4,0,$5, 0,0,0,'open','opening',$6)
         returning *`,
        [req.auth.branchId, ref, req.auth.userId, karat, costPerGram, costRef]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'create',$2,'lots',$3,$4)`,
        [req.auth.branchId, req.auth.userId, rows[0].id, JSON.stringify({ ref, karat, costPerGram, costRef, opening: true, businessDayId: day?.id || null })]
      );
      return { lot: rows[0] };
    });
    if (result.error) return res.status(409).json(result);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// إنهاء الافتتاح: الدفعات الافتتاحية تُقفل (بلا هالك — لا وزنَ مشترى يُقارن
// به)، ويعود التكويد إلى دفعات الموردين.
router.post("/opening/finish", authenticate, requirePage("openingBalance"), requireManager, async (req, res, next) => {
  try {
    const result = await withBranch(req.auth.branchId, async (client) => {
      const state = await openingState(client, req.auth.branchId);
      if (!state.on) return { error: "opening_mode_off" };
      const stats = await openingStats(client, req.auth.branchId);
      const { rows: closed } = await client.query(
        `update lots set status = 'closed', closed_at = now(), closed_by = $2, entered_weight = weight
          where branch_id = $1 and source = 'opening' and status = 'open'
          returning id`,
        [req.auth.branchId, req.auth.userId]
      );
      const { rows: st } = await client.query(
        `update branch_settings set opening_mode = false, opening_finished_at = now()
          where branch_id = $1 returning opening_finished_at`,
        [req.auth.branchId]
      );
      await client.query(
        `insert into audit_log (branch_id, event_type, actor_id, ref_table, ref_id, details)
         values ($1,'update',$2,'branch_settings',null,$3)`,
        [req.auth.branchId, req.auth.userId, JSON.stringify({ openingFinished: true, closedLots: closed.length, ...stats })]
      );
      return { finishedAt: st[0]?.opening_finished_at || null, closedLotIds: closed.map((r) => r.id), stats };
    });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
export { openingStats };
