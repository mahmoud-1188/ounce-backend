import { roundMoney } from "./money.js";

/**
 * زيادة الإدارة على السعر العالمي (applyHqMarkup في المرجع).
 *
 * سعر العمل في الفرع = العالمي + زيادةٌ تعتمدها الإدارة لكل متجر
 * (ريالًا لكل جرام 24 أو نسبة). العالمي يأتي آليًّا، أو يدويًّا إن ضبطته
 * الإدارة. والزيادة ثابتةٌ حتى تغيّرها — فتُطبَّق على كل سعرٍ جديد.
 */
function applyMarkup(world24, markup) {
  const w = Number(world24) || 0;
  if (!markup || !(Number(markup.value) > 0)) return roundMoney(w);
  const v = Number(markup.value) || 0;
  return roundMoney(markup.mode === "percent" ? w * (1 + v / 100) : w + v);
}

function shapePolicy(row) {
  if (!row) return { markup: null, world24Manual: null, at: null, by: null };
  const value = Number(row.price_markup_value) || 0;
  return {
    markup: value > 0 ? { mode: row.price_markup_mode === "percent" ? "percent" : "amount", value } : null,
    world24Manual: row.price_world24_manual == null ? null : Number(row.price_world24_manual),
    at: row.price_policy_at || null,
    by: row.price_policy_by || null,
  };
}

/** سياسة سعر متجر الفرع — استعلامٌ خارج RLS (الفرع يقرأ متجره فقط). */
async function loadBranchPricePolicy(client, branchId) {
  const { rows } = await client.query(
    `select s.price_markup_mode, s.price_markup_value, s.price_world24_manual, s.price_policy_at, s.price_policy_by
       from branches b join stores s on s.id = b.store_id where b.id = $1`,
    [branchId]
  );
  return shapePolicy(rows[0]);
}

/** إعلانات الإدارة السارية لمتجر الفرع. */
async function loadBranchNotices(client, branchId) {
  const { rows } = await client.query(
    `select n.id, n.text, n.created_by, n.created_at, n.until
       from store_notices n join branches b on b.store_id = n.store_id
      where b.id = $1 and n.until > now()
      order by n.created_at desc limit 20`,
    [branchId]
  );
  return rows.map((n) => ({ id: n.id, text: n.text, by: n.created_by || "الإدارة", at: n.created_at, until: n.until }));
}

export { applyMarkup, shapePolicy, loadBranchPricePolicy, loadBranchNotices };
