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
      sub: user.id,
      branchId: user.branch_id,
      role: user.role,
      name: user.name,
    },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );
}

function verifySession(token) {
  return jwt.verify(token, SECRET);
}

export { signSession, verifySession };
