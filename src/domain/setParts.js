/**
 * مكوّنات الطقم كما اختارها المكوِّد — تُقبل أسماءً («خاتم») أو كائنات { label, weight }.
 * ⚠ كانت الشاشة ترسلها (setPieces) والخادم يُسقطها، فلا يُعرف الجزء وقت بيعه.
 */
function cleanSetParts(v) {
  if (!Array.isArray(v)) return [];
  return v.map((p) => (typeof p === "string" ? { label: p } : p))
    .filter((p) => p && String(p.label || "").trim())
    .slice(0, 20)
    .map((p) => ({ label: String(p.label).trim().slice(0, 40), ...(Number(p.weight) > 0 ? { weight: Math.round(Number(p.weight) * 1000) / 1000 } : {}) }));
}

export { cleanSetParts };
