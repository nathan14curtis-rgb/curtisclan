/**
 * Money helpers. Every amount in this codebase is a signed integer number
 * of cents. Never a float — SQLite/D1 has no decimal type, and floating
 * point cents drift silently (PLAN.md §3).
 *
 * Sign convention: negative = money out (spend), positive = money in.
 */

export type Cents = number;

const DOLLAR_STRING = /^-?\d+(\.\d{1,2})?$/;

/** Parses a decimal dollar string ("47.83", "-12", "3.5") into integer
 * cents without going through float multiplication. Throws on anything
 * that isn't a plain decimal number. */
export function centsFromDollarString(input: string): Cents {
  const trimmed = input.trim();
  if (!DOLLAR_STRING.test(trimmed)) {
    throw new Error(`Not a valid dollar amount: ${JSON.stringify(input)}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [dollars, fraction = ""] = unsigned.split(".");
  const centsFraction = (fraction + "00").slice(0, 2);
  const magnitude = Number(dollars) * 100 + Number(centsFraction);
  return negative ? -magnitude : magnitude;
}

/** Formats integer cents back to a "$1,234.56" / "-$12.00" string. */
export function formatCents(cents: Cents, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(cents / 100);
}

export function assertIsCents(value: number, context = "amount"): asserts value is Cents {
  if (!Number.isInteger(value)) {
    throw new Error(`${context} must be an integer number of cents, got ${value}`);
  }
}

export function sumCents(...amounts: Cents[]): Cents {
  return amounts.reduce((total, amount) => {
    assertIsCents(amount);
    return total + amount;
  }, 0);
}
