// PIN hashing for the backend. The frontend's src/domain/hashPin.js is a
// hand-rolled hash (512 rounds of a custom mix) built for a browser with no
// crypto dependency — it was fine there because the frontend never held a
// real secret across a network. A real server has no such excuse: it uses
// bcrypt, the standard for password/PIN hashing in the Node ecosystem,
// which is deliberately slow (defeats brute force) and self-salting (no
// separate salt column to manage).
//
// This intentionally does NOT replicate the frontend's legacy-plaintext
// upgrade path (verifyPin.js's `"legacy"` return) — this is a fresh
// database with no old plaintext PINs to migrate.

import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

async function hashPin(pin) {
  return bcrypt.hash(String(pin), SALT_ROUNDS);
}

async function verifyPin(pin, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(pin), hash);
}

export { hashPin, verifyPin };
