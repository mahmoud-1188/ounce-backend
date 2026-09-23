// Postgres connection pool + a helper that runs a callback inside a
// transaction with `app.current_branch_id` set for that transaction only.
//
// Why this matters: schema.sql's Row Level Security policies (branch
// isolation) read `current_setting('app.current_branch_id')`. Using
// `SET LOCAL` inside an explicit transaction (not a bare `SET`) means the
// setting never leaks across pooled connections — each request gets a
// clean transaction, sets its own branch, and the pool is safe to reuse
// concurrently for other requests.

import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Runs `fn(client)` inside a transaction scoped to `branchId`. Every query
 * `fn` issues on `client` is subject to the branch_isolation RLS policies
 * for that branch only. Commits on success, rolls back on throw.
 */
async function withBranch(branchId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_branch_id', $1, true)", [
      branchId,
    ]);
    const result = await fn(client);
    // ⚠ المسارات ترفض بإرجاع { error } لا برمي استثناء، والمستدعي يردّ
    // 4xx. الإيداع هنا كان يُبقي ما كُتب قبل الرفض: بيعٌ بسطرين نفد
    // مخزون ثانيهما كان يترك قطع الأول مباعةً بلا فاتورة، ومرتجعٌ تعثّر
    // سطره الثاني يُبقي الأول عائدًا بلا مستند. الرفض الآن تراجعٌ كامل.
    if (result && typeof result === "object" && result.error) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For queries that are not branch-scoped (e.g. the login lookup, which
 * must find a user before we know we can trust their claimed branch).
 * Use sparingly — RLS does not apply, so hand-write the WHERE clause.
 */
async function withoutBranch(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * ⚠ مخصص للقراءة فقط (لا كتابة): يشغّل عدة استعلامات SELECT مستقلة بالتوازي
 * (متزامنًا على اتصالات منفصلة من الـpool) بدل من التتابع على اتصال واحد كما
 * تفعل withBranch. كل استعلام يأخذ اتصاله الخاص من الـpool ويضبط app.current_branch_id
 * له فقط داخل معاملة قصيرة خاصة به (SET LOCAL لا يؤثر على اتصالات أخرى) — فالعزل
 * بين الاستعلامات أمان تمامًا رغم تشغيلها في نفس اللحظة.
 *
 * ⚠ لا يُستخدم لأي عملية كتابة/تعديل تحتاج ذرية معاملة واحدة حقيقية (all-or-nothing) —
 * لهذه تبقى withBranch أعلاه. يفيد فقط عند تجميع قراءات SELECT مستقلة لا تعتمد
 * على بعضها البعض مثل GET /bootstrap.
 *
 * `tasks` مصفوفة من دوال async (client) => ... يُرجع كل منها قيمته
 * بنفس الترتيب. حجم الـpool الافتراضي (10 اتصالات) يكفي لهذا
 * الاستخدام طالما أنه يُستدعى مرة واحدة لكل دخول (لا عند كل تنقّل).
 */
async function withBranchParallel(branchId, tasks) {
  return Promise.all(
    tasks.map((task) =>
      withBranch(branchId, task)
    )
  );
}

export { pool, withBranch, withoutBranch, withBranchParallel };
