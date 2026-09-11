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

export { pool, withBranch, withoutBranch };
