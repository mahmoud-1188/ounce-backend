/**
 * تحكّم الإدارة في الفرع (migration 072).
 * linked: للمحل حسابٌ في الإدارة المركزية — فحدود الاعتماد وصلاحيات الموظفين لها ما لم تفوّض الفرع.
 */
async function branchDelegation(client, branchId) {
  const { rows } = await client.query(
    `select b.delegation,
            exists (select 1 from store_users su where su.store_id = b.store_id and su.active) as linked
       from branches b where b.id = $1`,
    [branchId]
  );
  const d = rows[0]?.delegation || {};
  return { linked: !!rows[0]?.linked, full: d.full === true, noApprovals: d.noApprovals === true };
}

// الفرع يدير حدوده وموظفيه بنفسه: محلٌّ بلا إدارة، أو فرعٌ فوّضته الإدارة كاملًا
const branchSelfManaged = (d) => !d.linked || d.full;

export { branchDelegation, branchSelfManaged };
