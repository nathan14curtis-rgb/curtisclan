import { sumCents, type Cents } from "../lib/money";

/**
 * The envelope balance recurrence (PLAN.md §3):
 *
 *   balance(month) = balance(month-1) + Σ allocations(month) − Σ spending(month)
 *
 * Telescoped from balance(start-1) = 0, this is equivalent to a single
 * running total — balance(month) = Σ_{m ≤ month} allocations(m) − Σ_{m ≤
 * month} spending(m) — which is what makes "always regenerable from the
 * ledger" a cheap aggregate query (src/db/envelopes.ts) instead of a
 * month-by-month replay. This function is the pure arithmetic underneath
 * both: sum the allocations, sum the net spend, subtract.
 */
export function computeEnvelopeBalance(allocationCents: Cents[], netSpendCents: Cents[]): Cents {
  return sumCents(...allocationCents) - sumCents(...netSpendCents);
}

/**
 * Net spend for a set of transactions already filtered to one envelope's
 * category and one time window. Sign convention: transaction amount_cents
 * is negative for money out, positive for money in — so summing directly
 * and negating gives spend as a positive magnitude, and a refund (a
 * positive amount_cents transaction in the same category) nets against it
 * automatically rather than counting as income (PLAN.md §3).
 */
export function netSpendCents(transactionAmountCents: Cents[]): Cents {
  // `|| 0` normalizes a -0 result (e.g. summing an empty list) to 0.
  return -sumCents(...transactionAmountCents) || 0;
}

/**
 * Ready to Assign, corrected for outstanding credit card balances
 * (PLAN.md §8.3.1). Spending $80 on a card moves nothing out of checking,
 * so Ready to Assign must subtract what's owed on the cards or it counts
 * money that's already spent as available to assign again.
 *
 * Valid only under the simplified credit-card model (§8.3): cards paid in
 * full every month, so "outstanding balance" is exactly "spent but not
 * yet paid." If a balance is ever carried, this aggregate correction
 * stops being accurate and real per-card payment envelopes are needed.
 */
export function computeReadyToAssign(
  depositoryBalancesCents: Cents[],
  creditCardBalancesCents: Cents[],
  envelopeBalancesCents: Cents[],
): Cents {
  const cashOnHand = sumCents(...depositoryBalancesCents) - sumCents(...creditCardBalancesCents);
  return cashOnHand - sumCents(...envelopeBalancesCents);
}
