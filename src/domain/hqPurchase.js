import { roundMoney } from "./money.js";
import { handleCreatePurchase } from "../routes/purchases.routes.js";

/**
 * شراء الإدارة على حساب فرع (migration 048 — المرجع: execHqPurchase).
 * يُنفَّذ بمعالج الشراء نفسه (POST /purchases) — القيود والخزنة والدفعات كما لو
 * سجّله الفرع، ويُعرَف مصدره من الملاحظة وسجل التدقيق.
 */
const KARATS = [24, 22, 21, 18, 14];

function parseHqPurchase(body = {}) {
  const supplierName = String(body.supplierName || "").trim();
  const payFrom = body.payFrom === "safe_network" ? "safe_network" : "safe_cash";
  const lines = (Array.isArray(body.lines) ? body.lines : []).map((l) => {
    const weight = Math.round((Number(l.weight) || 0) * 1000) / 1000;
    const wmPerGram = Number(l.wmPerGram ?? l.workmanshipPerGram) || 0;
    return {
      karat: Number(l.karat) || 21, weight, pieces: Math.max(0, Math.round(Number(l.pieces) || 0)),
      costPerGram: Number(l.costPerGram) || 0, workmanshipPerGram: wmPerGram,
      workmanshipTotal: l.workmanshipTotal != null ? roundMoney(l.workmanshipTotal) : roundMoney(wmPerGram * weight),
    };
  }).filter((l) => l.weight > 0);
  if (!supplierName) return { error: "supplier_required" };
  if (!lines.length) return { error: "no_lines" };
  if (lines.some((l) => !KARATS.includes(l.karat) || !(l.costPerGram > 0) || l.workmanshipTotal < 0)) return { error: "invalid_line" };
  const total = roundMoney(lines.reduce((a, l) => a + roundMoney(l.weight * l.costPerGram) + l.workmanshipTotal, 0));
  return { supplierName, payFrom, lines, total, note: String(body.note || "").trim().slice(0, 200), requireApproval: body.requireApproval !== false };
}

/** المورد بالاسم في الفرع، أو يُنشأ (fromHq). */
async function ensureSupplier(client, branchId, name) {
  const { rows } = await client.query("select id from suppliers where branch_id = $1 and lower(trim(name)) = lower(trim($2))", [branchId, name]);
  if (rows[0]) return rows[0].id;
  const { rows: n } = await client.query("select count(*)::int + 1 as n from suppliers where branch_id = $1", [branchId]);
  const { rows: ins } = await client.query(
    "insert into suppliers (branch_id, ref, name) values ($1,$2,$3) returning id",
    [branchId, `SUP-${String(n[0].n).padStart(6, "0")}`, name]
  );
  return ins[0].id;
}

/**
 * يُنفّذ الشراء داخل الفرع: يستدعي معالج الشراء بجلسةٍ مركّبة (auth) — والمعالج
 * يفتح معاملته بنفسه (withBranch)، فالمورد يُنشأ قبله في معاملةٍ مستقلة.
 */
async function runHqPurchase({ branchId, actorUserId = null, actorName = "الإدارة", role = "manager", p, supplierId, ref = "" }) {
  const req = {
    auth: { branchId, userId: actorUserId, role, user: { name: actorName } },
    body: {
      supplierId, paymentMethod: p.payFrom, invoicePending: true,
      notes: `شراء من الإدارة (${actorName})${ref ? ` · ${ref}` : ""}${p.note ? ` · ${p.note}` : ""}`,
      lines: p.lines.map((l) => ({ karat: l.karat, weight: l.weight, costPerGram: l.costPerGram, workmanshipTotal: l.workmanshipTotal, pieces: l.pieces })),
    },
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    handleCreatePurchase(req, res, (err) => (err ? reject(err) : resolve({ status: 500, body: { error: "internal_error" } })));
  });
}

export { parseHqPurchase, ensureSupplier, runHqPurchase };
