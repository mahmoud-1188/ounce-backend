// ═══════════════════════════════════════════════════════════════════
//  منطق مشترك لإدارة مستخدمي فرع — نظير AccessSettingsPage.jsx
// ═══════════════════════════════════════════════════════════════════
//
// ⚠ استُخرج من users.routes.js (لا كُتب من الصفر) — نفس السلوك حرفيًّا،
// فُصل ليُستدعى من مسارين مختلفين بنفس الضمانات (تكرار المنطق هنا كان
// سيعني أن حارسًا كـwouldLockOutAccess قد يُنسى تحديثه في أحدهما لاحقًا):
//   • /api/users/* (users.routes.js) — مستخدم فرعٍ يدير مستخدمي فرعه هو
//     (جلسة branch عادية، PIN قصير).
//   • /api/store/branches/:branchId/users (store.routes.js) — مستخدمٌ
//     مركزي يدير مستخدمي أي فرعٍ من فروع متجره عن بعد (الطبقة العليا
//     تتحقق من ملكية الفرع للمتجر أولًا — هذا الملف لا يعرف عن stores
//     إطلاقًا، فقط عن branchId مُمرَّر إليه مُوثَّقًا مسبقًا).
//
// كل دالة هنا تُستدعى داخل withBranch(branchId, fn) من المستدعي (لا
// تفتح معاملتها الخاصة) — لتبقى قابلة للتركيب مع أي معاملة أعلى مستقبلًا.

import { hashPin, verifyPin } from "../auth/hashPin.js";
import { diffPages, logPermission } from "./permissionLog.js";
import { normalizeName } from "../auth/normalizeName.js";
import { currentAllowed, wouldLockOutAccess, wouldRemoveLastManager } from "../auth/permissions.js";

// ⚠ رمز موظف قصير (4 محارف) ليُقال ويُكتب بسهولة على أرض المحل — أقصر
// عمدًا من رمز الفرع (BR-XXXXXXXX، ثماني محارف): الفرع يُنشأ نادرًا
// ويُدخله مدير مرة واحدة على جهاز، بينما رمز الموظف يُكتب يوميًّا في
// شاشة الدخول (راجع PriceLoginScreen.jsx) فطوله يُكلَّف كل يوم لا مرة.
// حروف مستبعدة عمدًا لتفادي الالتباس: 0/O، 1/I/L — يُنطق الرمز بصوتٍ
// عالٍ أحيانًا، فتشابه الشكل يعني خطأً متكررًا.
const EMPLOYEE_REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function randomEmployeeRefCandidate() {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += EMPLOYEE_REF_ALPHABET[Math.floor(Math.random() * EMPLOYEE_REF_ALPHABET.length)];
  }
  return out;
}

/**
 * يولّد رمز موظفٍ فريدًا (users.ref فريدٌ على مستوى كل قاعدة البيانات،
 * لا الفرع وحده — راجع migration 002) ويتحقق من عدم تكراره فعليًّا قبل
 * إرجاعه، بنفس نمط توليد ref الفرع في store.routes.js تمامًا.
 */
async function generateUniqueEmployeeRef(client) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomEmployeeRefCandidate();
    const { rows } = await client.query("select 1 from users where ref = $1", [candidate]);
    if (!rows.length) return candidate;
  }
  return null;
}

async function loadBranchUsersWithRoles(client, branchId) {
  const { rows } = await client.query(
    `select u.*, r.allowed_tabs, r.allowed_more
       from users u join roles r on r.id = u.role
      where u.branch_id = $1 and u.active = true`,
    [branchId]
  );
  return rows.map((u) => ({
    ...u,
    allowed: currentAllowed(u, { allowed_tabs: u.allowed_tabs, allowed_more: u.allowed_more }),
  }));
}

/** POST — يُطابق add() + valid guard في AccessSettingsPage.jsx حرفيًّا. */
async function createBranchUser(client, branchId, { name, pin, role, salary }, actor = {}) {
  const roleId = role || "employee";
  const { rows: roleRows } = await client.query("select 1 from roles where id = $1", [roleId]);
  if (!roleRows[0]) return { error: "invalid_role" };

  const existing = await loadBranchUsersWithRoles(client, branchId);

  const nameTaken = existing.some((u) => normalizeName(u.name) === normalizeName(name));
  if (nameTaken) return { error: "name_taken" };

  // bcrypt hashes are salted per-row, so "is this PIN already used" can't
  // be a SQL index lookup — نقارن ضد كل تجزئة قائمة في الفرع، تمامًا كحلقة
  // pinTaken في الفرونت إند.
  for (const u of existing) {
    if (await verifyPin(pin, u.pin_hash)) return { error: "pin_taken" };
  }

  const pinHash = await hashPin(pin);
  const ref = await generateUniqueEmployeeRef(client);
  const { rows } = await client.query(
    `insert into users (branch_id, name, role, pin_hash, salary, ref)
     values ($1, $2, $3, $4, $5, $6)
     returning id, name, role, salary, ref, created_at`,
    [branchId, name.trim(), roleId, pinHash, Number(salary) || 0, ref]
  );
  await logPermission(client, branchId, {
    targetId: rows[0].id, targetName: rows[0].name, kind: "create", after: { role: roleId }, actor,
  });
  return { user: rows[0] };
}

/** PATCH .../rename — يُطابق rename() حرفيًّا. */
async function renameBranchUser(client, branchId, userId, name, actor = {}) {
  const existing = await loadBranchUsersWithRoles(client, branchId);
  const nameTaken = existing.some(
    (u) => u.id !== userId && normalizeName(u.name) === normalizeName(name)
  );
  if (nameTaken) return { error: "name_taken" };
  const { rows } = await client.query(
    `update users set name = $1 where id = $2 and branch_id = $3 returning id, name`,
    [name.trim(), userId, branchId]
  );
  if (!rows[0]) return { error: "not_found" };
  const old = existing.find((u) => u.id === userId);
  await logPermission(client, branchId, {
    targetId: userId, targetName: rows[0].name, kind: "rename", before: { name: old?.name || null }, after: { name: rows[0].name }, actor,
  });
  return { user: rows[0] };
}

/** PATCH .../ai — يُطابق toggleAi() حرفيًّا. */
async function setBranchUserAi(client, branchId, userId, canUseAi, actor = {}) {
  const { rows } = await client.query(
    `update users set can_use_ai = $1 where id = $2 and branch_id = $3
     returning id, name, can_use_ai`,
    [!!canUseAi, userId, branchId]
  );
  if (!rows[0]) return { error: "not_found" };
  await logPermission(client, branchId, {
    targetId: userId, targetName: rows[0].name, kind: "ai", after: { canUseAi: !!canUseAi }, actor,
  });
  return { user: { id: rows[0].id, can_use_ai: rows[0].can_use_ai } };
}

/** PATCH .../permissions — يُطابق togglePage()/resetToRole() حرفيًّا (null = افتراضي الدور). */
async function setBranchUserPermissions(client, branchId, userId, allowedPages, actor = {}) {
  const existing = await loadBranchUsersWithRoles(client, branchId);
  const target = existing.find((u) => u.id === userId);
  if (!target) return { error: "not_found" };

  if (allowedPages !== null) {
    if (wouldLockOutAccess(existing, target.id, allowedPages)) {
      return {
        error: "would_lock_out_access",
        message: "لا يمكن إزالة «صلاحيات الوصول» من آخر مستخدم يملكها — سيتعذّر تعديل أي صلاحية بعدها.",
      };
    }
  }

  const { rows } = await client.query(
    `update users set allowed_pages = $1 where id = $2 and branch_id = $3
     returning id, allowed_pages`,
    [allowedPages === null ? null : JSON.stringify(allowedPages), userId, branchId]
  );
  // الفرق بين ما كان يملكه فعليًّا وما صار له (الافتراضي يُحلّ لصفحات الدور)
  const { rows: roleRows } = await client.query("select allowed_tabs, allowed_more from roles where id = $1", [target.role]);
  const roleDefault = roleRows[0] ? currentAllowed({ allowed_pages: null }, roleRows[0]) : [];
  const nextEffective = allowedPages === null ? roleDefault : allowedPages;
  const { added, removed } = diffPages(target.allowed, nextEffective);
  if (added.length || removed.length || allowedPages === null) {
    await logPermission(client, branchId, {
      targetId: userId, targetName: target.name, kind: allowedPages === null ? "reset" : "pages",
      before: target.allowed, after: nextEffective, added, removed, actor,
    });
  }
  return { user: rows[0] };
}

/** DELETE — يُطابق remove() حرفيًّا (يرفض حذف آخر manager، تعطيلٌ منطقي لا حذف). */
async function removeBranchUser(client, branchId, userId, actor = {}) {
  const existing = await loadBranchUsersWithRoles(client, branchId);
  if (wouldRemoveLastManager(existing, userId)) {
    return { error: "would_remove_last_manager" };
  }
  const { rowCount } = await client.query(
    `update users set active = false where id = $1 and branch_id = $2`,
    [userId, branchId]
  );
  if (!rowCount) return { error: "not_found" };
  const gone = existing.find((u) => u.id === userId);
  await logPermission(client, branchId, {
    targetId: userId, targetName: gone?.name || null, kind: "delete", before: { role: gone?.role || null, pages: gone?.allowed || [] }, actor,
  });
  return { ok: true };
}

export {
  loadBranchUsersWithRoles,
  createBranchUser,
  renameBranchUser,
  setBranchUserAi,
  setBranchUserPermissions,
  removeBranchUser,
};
