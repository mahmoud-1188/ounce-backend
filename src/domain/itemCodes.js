/**
 * أرقام القطع (ITM-000001) تُرقَّم لكل فرع، لكن رمز الوحدة (item_units.code) فريدٌ في كل الفروع — فأوّل تكويدٍ
 * في فرعٍ ثانٍ كان يصطدم برمزٍ مستعمل في الأوّل (خطأ خادم). الرقم التالي من أعلى رقمٍ في الفرع (لا من العدّ —
 * الحذف والوارد بالتحويل يُفسدان العدّ)، والرمز المستعمل في فرعٍ آخر يُميَّز بلاحقة.
 */
async function nextItemRefNum(client, branchId) {
  const { rows } = await client.query(
    `select coalesce(max((substring(ref from '^ITM-(\\d+)$'))::int), 0) + 1 as n from items where branch_id = $1`, [branchId]);
  return rows[0].n;
}

const itemRefOf = (n) => `ITM-${String(n).padStart(6, "0")}`;

/// يُدرج وحدةً برمزها — وعند اصطدامه برمزٍ في فرعٍ آخر يُعاد بلاحقةٍ قصيرة داخل نقطة حفظ (لا تُفسد المعاملة)
async function insertUnit(client, itemId, code) {
  for (let i = 0; i < 6; i++) {
    const c = i === 0 ? code : `${code}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    await client.query("savepoint unit_code");
    try {
      const { rows } = await client.query(
        "insert into item_units (item_id, code) values ($1, $2) returning id, code, printed, sold", [itemId, c]);
      await client.query("release savepoint unit_code");
      return rows[0];
    } catch (err) {
      await client.query("rollback to savepoint unit_code");
      if (err.code !== "23505") throw err;
    }
  }
  throw new Error("unit_code_exhausted");
}

export { nextItemRefNum, itemRefOf, insertUnit };
