// Extracted programmatically (byte-for-byte) from
// src/domain/helpers.js normalizeName() — never retyped by hand, to
// guarantee the backend's duplicate-name check matches the frontend's
// exactly, including the invisible/diacritic Unicode ranges involved.

function normalizeName(v) {
  return String(v || "")
    .trim()
    // ⚠ التشكيل أولًا: يقع بين الحروف فيُفسد كل استبدالٍ بعده
    .replace(/[\u064B-\u065F\u0670]/g, "")
    // والتطويل: «أحـمد» و«أحمد» واحد
    .replace(/\u0640/g, "")
    // ومحارف الاتجاه والمسافات الصفرية — تُلصق خفيةً بالنسخ واللصق
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[ىي]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    // الأرقام العربية والهندية سواء
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .toLowerCase();
}


export { normalizeName };
