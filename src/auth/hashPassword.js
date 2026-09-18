// كلمة مرور المستخدم المركزي (store_users) — نفس آلية hashPin.js
// (bcrypt، نفس عدد الجولات) لكن باسمٍ مستقل: PIN مستخدم الفرع رقمٌ قصير
// لجهازٍ مشترك، وكلمة مرور المركزي نصٌّ حرٌّ لحسابٍ شخصي — المفهومان
// مختلفان رغم تطابق الآلية تحتها، فلا نُسمّي الوحدة باسم PIN لمنطقٍ
// لا علاقة له بأي PIN.

import bcrypt from "bcrypt";

const SALT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(String(password), SALT_ROUNDS);
}

async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(password), hash);
}

export { hashPassword, verifyPassword };
