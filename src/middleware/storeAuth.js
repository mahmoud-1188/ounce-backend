import { verifySession } from "../auth/jwt.js";
import { withoutBranch } from "../db.js";

/**
 * ⚠ نظير authenticate في auth.js لكن للمستخدم المركزي (store_users) —
 * منفصل تمامًا لا فرعًا منه، لأن شكل الهوية مختلف جذريًا: لا branchId
 * هنا (المستخدم المركزي يرى كل فروع متجره لا فرعًا بعينه)، بل storeId.
 *
 * ⚠ يرفض أي توكن ليس scope: "store" صراحةً — بلا هذا الفحص، توكن فرعٍ
 * عادي (scope: "branch" أو توكن قديم بلا scope إطلاقًا) كان سيمرّ هنا
 * ببساطة لأن verifySession وحدها تتحقق من التوقيع لا من نوع الجلسة،
 * ويصير req.auth.storeId = undefined بلا أي خطأ ظاهر — كل استعلامٍ تاليٍ
 * يستخدمه سيفشل بصمت أو (أخطر) يمرّ storeId = null لاستعلامٍ لا يتوقعه.
 */
async function authenticateStore(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }

  let payload;
  try {
    payload = verifySession(token);
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }

  if (payload.scope !== "store") {
    return res.status(401).json({ error: "wrong_token_scope" });
  }

  try {
    const { rows } = await withoutBranch((client) =>
      client.query(
        `select su.*, s.status as store_status, s.subscription_expires_at
           from store_users su
           join stores s on s.id = su.store_id
          where su.id = $1 and su.store_id = $2 and su.active = true`,
        [payload.sub, payload.storeId]
      )
    );
    const storeUser = rows[0];
    if (!storeUser) {
      return res.status(401).json({ error: "store_user_not_found_or_inactive" });
    }
    // ⚠ فحصٌ حقيقي هنا لا في الواجهة فقط: اشتراكٌ موقوف أو منتهٍ يمنع كل
    // استدعاء مركزي فورًا — لا ينتظر أن يفشل عند أول استعلامٍ فرعي غامض.
    if (storeUser.store_status !== "active") {
      return res.status(403).json({ error: `store_${storeUser.store_status}` });
    }
    if (
      storeUser.subscription_expires_at &&
      new Date(storeUser.subscription_expires_at).getTime() < Date.now()
    ) {
      return res.status(403).json({ error: "subscription_expired" });
    }

    req.storeAuth = {
      storeUserId: storeUser.id,
      storeId: storeUser.store_id,
      role: storeUser.role,
      name: storeUser.name,
      // ⚠ null يعني "owner بلا قيد" (نفس اتفاقية allowed_pages في جدول
      // users لمستخدم الفرع) — لا "لا شيء مسموح". راجع
      // migration 023_store_user_permissions.sql.
      allowedPages: storeUser.allowed_pages,
      canManageBranches: !!storeUser.can_manage_branches,
      canSendCoding: !!storeUser.can_send_coding,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** يقصر مسارًا على owner فقط — إضافة/حذف موظفي المركزي أنفسهم مثلًا. */
function requireStoreOwner(req, res, next) {
  if (req.storeAuth?.role !== "owner") {
    return res.status(403).json({ error: "owner_only" });
  }
  next();
}

/**
 * يقصر مسارًا على owner أو موظفٍ مُصرَّح له صراحةً بإدارة الفروع
 * (can_manage_branches) — إنشاء فرعٍ جديد قرارٌ تجاري لا شاشة عرض،
 * فمستقلٌّ عمدًا عن allowedPages (رؤية شاشة الفروع لا تعني إنشاء فرعٍ
 * فيها بالضرورة).
 */
function requireCanManageBranches(req, res, next) {
  if (req.storeAuth?.role === "owner" || req.storeAuth?.canManageBranches) {
    return next();
  }
  return res.status(403).json({ error: "cannot_manage_branches" });
}

/**
 * يقصر مسارًا على owner أو موظفٍ مُصرَّح له صراحةً بإرسال تكويد لفرع
 * (can_send_coding) — نفس مبرّر requireCanManageBranches تمامًا: إرسال
 * بضاعة فعليًّا فعلٌ تجاري خطير، لا مجرّد رؤية شاشة hqCoding ضمن
 * allowedPages. راجع migration 026_store_user_coding_permission.sql.
 */
function requireCanSendCoding(req, res, next) {
  if (req.storeAuth?.role === "owner" || req.storeAuth?.canSendCoding) {
    return next();
  }
  return res.status(403).json({ error: "cannot_send_coding" });
}

export { authenticateStore, requireStoreOwner, requireCanManageBranches, requireCanSendCoding };
