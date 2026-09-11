// Reads posting_rules from the database (seeded verbatim from erp.js
// POSTING_RULES in seed.sql) rather than duplicating them in JS — one
// source of truth, no drift risk between the two.

async function getPostingRule(client, opType) {
  const { rows } = await client.query(
    "select rule, label from posting_rules where op_type = $1",
    [opType]
  );
  if (!rows[0]) throw new Error(`unknown_op_type:${opType}`);
  return { ...rows[0].rule, label: rows[0].label };
}

export { getPostingRule };
