// Integer-halala arithmetic, ported from src/core/money.js's toMinor/
// fromMinor for the number-only case (the backend receives already-parsed
// JSON numbers, never raw keyboard strings, so the string-parsing branch
// of the original toMinor isn't needed here — but the float-safety
// reasoning is identical: `total - total/(1+rate)` on raw floats loses
// halalas across thousands of invoices, exactly as money.js's comments
// warn).

function toHalalas(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(2);
  const [whole, frac = ""] = fixed.split(".");
  const digits = (whole + frac.padEnd(2, "0")).replace(/^0+(?=\d)/, "");
  const out = Number(digits || "0");
  return neg ? -out : out;
}

function fromHalalas(h) {
  return Math.trunc(Number(h) || 0) / 100;
}

/**
 * Extracts the tax portion from a tax-inclusive total, halala-exact.
 * Ported verbatim in spirit from handleCreateSale's:
 *   taxAmount = fromHalalas(halalas(total) - Math.round(halalas(total) / (1 + taxRate)))
 */
function extractInclusiveTax(total, taxRate) {
  const totalH = toHalalas(total);
  const netH = Math.round(totalH / (1 + Number(taxRate || 0)));
  return fromHalalas(totalH - netH);
}

/** Rounds to the nearest halala (2 decimal places) as a plain number. */
function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export { toHalalas, fromHalalas, extractInclusiveTax, roundMoney };
