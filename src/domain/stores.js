import { withoutBranch } from "../db.js";

/**
 * ⚠ سقف الفروع لكل متجر (migration 020_stores_multi_tenant.sql):
 * stores.max_branches يحدَّده الأدمن حسب باقة الاشتراك، لا الفرع/المتجر
 * نفسه. هذه الدالة هي الفحص الحقيقي الوحيد الذي يجب أن يعتمد عليه أي
 * مسار إنشاء فرع جديد مستقبلًا — لا تُغني عنه أي واجهة تخفي الزر عند
 * الوصول للسقف.
 *
 * ⚠ stores ليس جدولًا مُعزَّزًا بـRLS (لا branch_id فيه أصلًا — هو الأب
 * الذي تُعزل الفروع تحته عبر branches.store_id)، فالاستعلام هنا يمرّ عبر
 * withoutBranch عمدًا، تمامًا كما يفعل hq.routes.js عند القراءة من جدول
 * branches نفسه (راجع assertHqBranch هناك لنفس النمط).
 *
 * @param {string} storeId
 * @returns {Promise<{ok: boolean, reason?: string, branchCount?: number, maxBranches?: number}>}
 */
async function storeCanAddBranch(storeId) {
  const { rows } = await withoutBranch((client) =>
    client.query(
      `select s.max_branches, s.status, s.subscription_expires_at,
              (select count(*)::int from branches b where b.store_id = s.id) as branch_count
         from stores s
        where s.id = $1`,
      [storeId]
    )
  );
  const store = rows[0];
  if (!store) {
    return { ok: false, reason: "store_not_found" };
  }
  if (store.status !== "active") {
    return { ok: false, reason: `store_${store.status}` };
  }
  if (store.subscription_expires_at && new Date(store.subscription_expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "subscription_expired" };
  }
  if (store.branch_count >= store.max_branches) {
    return {
      ok: false,
      reason: "branch_limit_reached",
      branchCount: store.branch_count,
      maxBranches: store.max_branches,
    };
  }
  return { ok: true, branchCount: store.branch_count, maxBranches: store.max_branches };
}

export { storeCanAddBranch };
