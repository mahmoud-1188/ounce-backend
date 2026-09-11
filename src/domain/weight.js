// Purity table ported verbatim from src/core/money.js PURITY.

const PURITY = { 24: 1, 22: 22 / 24, 21: 21 / 24, 18: 18 / 24, 14: 14 / 24 };

function fineWeight(weight, karat) {
  const p = PURITY[karat];
  if (p == null) throw new Error(`invalid_karat:${karat}`);
  return Math.round(Number(weight) * p * 1000) / 1000;
}

/**
 * Rounds a gram weight to 3 decimals — matching every weight column's
 * actual precision (`numeric(12,3)`).
 *
 * ⚠ إصلاح حقيقي اكتُشف أثناء بناء استهلاك FIFO في purchases.routes.js:
 * scrap.routes.js كان يستخدم roundMoney (تقريب لخانتين، مصمَّم للهللات)
 * لفروقات الوزن (break_variance، assessedFine/sentFine، إلخ) — يُفقِد
 * الخانة الثالثة من دقة numeric(12,3) بصمت. rounded weight values now
 * go through this instead, everywhere weight arithmetic happens.
 */
function roundWeight(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

export { PURITY, fineWeight, roundWeight };
