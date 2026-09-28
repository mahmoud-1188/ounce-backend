import crypto from "crypto";

/// أجهزة الدخول المربوطة (migration 062)
const DEVICE_LOCK_ROLES = { managers: ["manager", "assistant", "accountant"] };
const tokenHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const needsDevice = (lock, role) => lock === "all" || (lock === "managers" && DEVICE_LOCK_ROLES.managers.includes(role));

async function createDevice(client, { branchId, userId = null, label = null, userAgent = null, createdBy = null }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const { rows } = await client.query(
    `insert into devices (branch_id, user_id, label, token_hash, user_agent, created_by, last_seen_at)
     values ($1,$2,$3,$4,$5,$6, now()) returning id`,
    [branchId, userId, label, tokenHash(token), userAgent ? String(userAgent).slice(0, 200) : null, createdBy]);
  return { deviceId: rows[0].id, deviceToken: token };
}

/// الجهاز من مفتاحه — null إن لم يُعرف أو أُلغي أو كان لفرعٍ آخر
async function findDevice(client, branchId, token) {
  if (!token) return null;
  const { rows } = await client.query(
    "select * from devices where token_hash = $1 and branch_id = $2 and revoked_at is null", [tokenHash(token), branchId]);
  return rows[0] || null;
}

/// وصفٌ مختصر للجهاز من المتصفح — «آيفون · سفاري» — لقائمة الأجهزة
function deviceLabel(ua = "") {
  const s = String(ua);
  const os = /iPad/.test(s) ? "آيباد" : /iPhone/.test(s) ? "آيفون" : /Android/.test(s) ? (/Mobile/.test(s) ? "أندرويد" : "تابلت أندرويد") : /Windows/.test(s) ? "ويندوز" : /Mac OS/.test(s) ? "ماك" : "جهاز";
  const br = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : /Firefox\//.test(s) ? "Firefox" : "";
  return br ? `${os} · ${br}` : os;
}

const shapeDevice = (d) => ({
  id: d.id, userId: d.user_id, userName: d.user_name || null, shared: !d.user_id, label: d.label || "",
  createdAt: d.created_at, createdBy: d.created_by || "", lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at,
});

/// أجهزة الفرع كلها مع أسماء أصحابها، وحالة السياسة وعدد من لم يربط بعد
async function branchDevices(client, branchId) {
  const { rows } = await client.query(
    `select d.*, u.name as user_name from devices d left join users u on u.id = d.user_id
      where d.branch_id = $1 order by d.revoked_at nulls first, d.created_at desc limit 300`, [branchId]);
  const { rows: [st] } = await client.query("select coalesce(device_lock, 'off') as lock from branch_settings where branch_id = $1", [branchId]);
  const lock = st?.lock || "off";
  const { rows: staff } = await client.query(
    `select u.id, u.name, u.role, exists (select 1 from devices d where d.user_id = u.id and d.revoked_at is null) as has_device
       from users u where u.branch_id = $1 and u.active = true order by u.name`, [branchId]);
  const shared = rows.some((d) => !d.user_id && !d.revoked_at);
  return {
    lock, devices: rows.map(shapeDevice), sharedDevice: shared,
    staff: staff.map((u) => ({ id: u.id, name: u.name, role: u.role, hasDevice: u.has_device, required: needsDevice(lock, u.role) })),
  };
}

async function revokeDevice(client, branchId, deviceId, by) {
  const { rows } = await client.query(
    "update devices set revoked_at = now(), revoked_by = $3 where id = $1 and branch_id = $2 and revoked_at is null returning id",
    [deviceId, branchId, by]);
  return rows[0] ? { ok: true } : { error: "not_found" };
}

export { branchDevices, revokeDevice, createDevice, deviceLabel, findDevice, needsDevice, shapeDevice, tokenHash };
