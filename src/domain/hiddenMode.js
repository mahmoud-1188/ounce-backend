import { hashPin, verifyPin } from "../auth/hashPin.js";

/**
 * الوضع الخفي (migration 047) — المرجع 5.2.0: hiddenModeConfig · isHiddenPin.
 * الرقم الافتراضي 123456 ما لم يغيّره المدير، والوضع مفعّل افتراضًا.
 */
const HIDDEN_DEFAULT_PIN = "123456";
const HIDDEN_USER_NAME = "مخزون وجرد";

async function hiddenConfig(client, branchId) {
  const { rows } = await client.query(
    "select hidden_mode_enabled, hidden_pin_hash from branch_settings where branch_id = $1",
    [branchId]
  );
  const r = rows[0] || {};
  return { enabled: r.hidden_mode_enabled !== false, pinHash: r.hidden_pin_hash || null, isDefault: !r.hidden_pin_hash };
}

/** هل هذا رقم الوضع الخفي (والوضع مفعّل)؟ */
async function isHiddenPin(client, branchId, pin) {
  const p = String(pin == null ? "" : pin);
  if (!/^\d{4,8}$/.test(p)) return false;
  const c = await hiddenConfig(client, branchId);
  if (!c.enabled) return false;
  return c.pinHash ? verifyPin(p, c.pinHash) : p === HIDDEN_DEFAULT_PIN;
}

/** رقمٌ جديد للوضع الخفي — لا يطابق رقم أي موظّف في الفرع. */
async function setHiddenPin(client, branchId, pin) {
  const p = String(pin || "");
  if (!/^\d{4,6}$/.test(p)) return { error: "invalid_pin" };
  const { rows } = await client.query("select pin_hash from users where branch_id = $1 and active = true", [branchId]);
  for (const u of rows) if (await verifyPin(p, u.pin_hash)) return { error: "pin_taken" };
  await client.query(
    `insert into branch_settings (branch_id, hidden_pin_hash) values ($1, $2)
     on conflict (branch_id) do update set hidden_pin_hash = excluded.hidden_pin_hash`,
    [branchId, await hashPin(p)]
  );
  return { ok: true };
}

export { HIDDEN_DEFAULT_PIN, HIDDEN_USER_NAME, hiddenConfig, isHiddenPin, setHiddenPin };
