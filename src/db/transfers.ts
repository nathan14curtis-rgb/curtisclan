import { findTransferMatch, type TransferCandidate } from "../categorization/transferDetection";
import { nowIso } from "./client";

/**
 * Looks for the opposite-signed leg of `transaction` in another account in
 * the same household within a few days, and if found, marks both rows
 * is_transfer=1 (PLAN.md §3). Envelope math already excludes
 * is_transfer=1 rows (src/db/envelopes.ts), so this is the only step
 * needed to keep a card payment from double-counting as spend.
 */
export async function detectAndMarkTransfer(
  db: D1Database,
  householdId: string,
  transaction: TransferCandidate,
  windowDays?: number,
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `SELECT id, account_id AS accountId, amount_cents AS amountCents, posted_at AS postedAt
         FROM "transaction"
        WHERE household_id = ? AND is_transfer = 0 AND id != ?
          AND amount_cents = ?
          AND posted_at BETWEEN date(?, '-7 days') AND date(?, '+7 days')`,
    )
    .bind(householdId, transaction.id, -transaction.amountCents, transaction.postedAt, transaction.postedAt)
    .all<TransferCandidate>();

  const match = findTransferMatch(transaction, results, windowDays);
  if (!match) return false;

  const now = nowIso();
  await db.batch([
    db.prepare(`UPDATE "transaction" SET is_transfer = 1, updated_at = ? WHERE id = ?`).bind(now, transaction.id),
    db.prepare(`UPDATE "transaction" SET is_transfer = 1, updated_at = ? WHERE id = ?`).bind(now, match.id),
  ]);
  return true;
}
