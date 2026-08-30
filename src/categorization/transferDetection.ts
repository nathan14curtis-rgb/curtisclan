/**
 * "Transfers are not expenses. A card payment from checking is one
 * movement, not income plus expense. Detect by matching opposite-signed
 * amounts across household accounts within a few days." (PLAN.md §3)
 */
export interface TransferCandidate {
  id: string;
  accountId: string;
  amountCents: number;
  postedAt: string; // 'YYYY-MM-DD' or ISO datetime
}

const DEFAULT_WINDOW_DAYS = 4;

/** Finds the first candidate in a different account whose amount exactly
 * cancels this transaction's, within a few days either direction. Exact
 * cancellation (not "close enough") is deliberate — a near-miss is far
 * more likely to be two unrelated transactions than a same-amount
 * coincidence for genuinely different purchases. */
export function findTransferMatch(
  txn: TransferCandidate,
  candidates: TransferCandidate[],
  windowDays = DEFAULT_WINDOW_DAYS,
): TransferCandidate | null {
  const txnTime = new Date(txn.postedAt).getTime();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  return (
    candidates.find((candidate) => {
      if (candidate.id === txn.id) return false;
      if (candidate.accountId === txn.accountId) return false;
      if (candidate.amountCents !== -txn.amountCents) return false;
      const candidateTime = new Date(candidate.postedAt).getTime();
      return Math.abs(candidateTime - txnTime) <= windowMs;
    }) ?? null
  );
}
