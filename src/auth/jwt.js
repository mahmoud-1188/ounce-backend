import jwt from "jsonwebtoken";
import "dotenv/config";

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error(
    "JWT_SECRET is not set. Copy .env.example to .env and set a real secret before starting the server."
  );
}

// A business day is the natural session boundary for this app (see
// business_days in the schema) — 12h covers a normal working day with
// margin, without leaving tokens valid indefinitely.
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

function signSession(user) {
  return jwt.sign(
    {
      // ⚠ scope صريح منذ الآن لمنع الخلط مع توكن store_users
      // (راجع signStoreSession أسفله) — وسيطة authenticate في
      // middleware/auth.js ترفض أي توكن ليس scope: "branch"، فتوكن
      // store_users لا يمر من مسار فرع بالخطأ والعكس.
      scope: "branch",
      sub: user.id,
      branchId: user.branch_id,
      role: user.role,
      name: user.name,
    },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

/**
 * جلسة المستخدم المركزي (store_users) — منفصلة عمدًا عن
 * signSession: لا branchId هنا أصلًا (المستخدم المركزي يرى كل فروع
 * متجره، لا فرعًا واحدًا) وstoreId بدلًا منه.
 */
function signStoreSession(storeUser) {
  return jwt.sign(
    {
      scope: "store",
      sub: storeUser.id,
      storeId: storeUser.store_id,
      role: storeUser.role,
      name: storeUser.name,
    },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function verifySession(token) {
  return jwt.verify(token, SECRET);
}

export { signSession, signStoreSession, verifySession };
