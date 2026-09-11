// Posts one balanced double-entry journal entry. The database's
// `check_journal_balance` trigger (schema.sql) is the real, final
// enforcement — this pre-check exists only to fail with a clear message
// before hitting the database, instead of a raw constraint-trigger error.

async function postJournalEntry(
  client,
  { branchId, businessDayId, opType, refTable, refId, description, createdBy, lines }
) {
  // Drop zero-amount lines (e.g. a tax split when there's no tax) BEFORE
  // checking balance — checking against the unfiltered list and then
  // inserting the filtered one is how a "balanced on paper" entry could
  // still get inserted lopsided.
  const filtered = (lines || []).filter((l) => Math.round((l.amount || 0) * 100) > 0);

  if (filtered.length < 2) {
    throw new Error(`journal_entry_needs_at_least_two_lines:${opType}`);
  }
  const debit = filtered
    .filter((l) => l.side === "debit")
    .reduce((a, l) => a + l.amount, 0);
  const credit = filtered
    .filter((l) => l.side === "credit")
    .reduce((a, l) => a + l.amount, 0);
  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    throw new Error(
      `journal_entry_unbalanced:${opType}:debit=${debit.toFixed(2)}:credit=${credit.toFixed(2)}`
    );
  }

  const { rows } = await client.query(
    `insert into journal_entries (branch_id, business_day_id, op_type, ref_table, ref_id, description, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [branchId, businessDayId, opType, refTable, refId, description, createdBy]
  );
  const entryId = rows[0].id;

  for (const l of filtered) {
    await client.query(
      `insert into journal_lines (entry_id, account_code, side, amount) values ($1, $2, $3, $4)`,
      [entryId, l.account, l.side, l.amount]
    );
  }
  return entryId;
}

export { postJournalEntry };
