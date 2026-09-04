import { newId } from "../lib/id";
import type { Account, Clarification, ClarificationStatus, User } from "../types";
import { getScoped, nowIso } from "./client";

/**
 * The nominal asker recorded on a clarification (PLAN.md §3: owner_user_id
 * "routes a question to the right person"). Since every clarification is
 * actually sent to the shared household group thread (§13 Q6 is answered
 * by asking everyone at once), this no longer picks who receives the
 * text — it's audit/context only (clarification.user_id). Falls back to
 * the first verified household user when the account has no owner.
 */
export async function resolveAskee(db: D1Database, householdId: string, account: Account): Promise<User | null> {
  if (account.owner_user_id) {
    const owner = await db
      .prepare(`SELECT * FROM user WHERE id = ? AND household_id = ? AND phone_verified_at IS NOT NULL`)
      .bind(account.owner_user_id, householdId)
      .first<User>();
    if (owner) return owner;
  }
  return db
    .prepare(`SELECT * FROM user WHERE household_id = ? AND phone_verified_at IS NOT NULL ORDER BY created_at LIMIT 1`)
    .bind(householdId)
    .first<User>();
}

export async function createClarification(
  db: D1Database,
  householdId: string,
  input: { transactionId: string; userId: string; questionText: string },
): Promise<Clarification> {
  const id = newId("clr");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO clarification (id, household_id, transaction_id, user_id, status, question_text, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .bind(id, householdId, input.transactionId, input.userId, input.questionText, now)
    .run();
  return {
    id,
    household_id: householdId,
    transaction_id: input.transactionId,
    user_id: input.userId,
    status: "queued",
    question_text: input.questionText,
    sendblue_handle: null,
    sent_at: null,
    answered_at: null,
    timed_out_at: null,
    created_at: now,
  };
}

export async function getClarification(db: D1Database, householdId: string, id: string): Promise<Clarification> {
  return getScoped<Clarification>(db, "clarification", householdId, id);
}

export async function markClarificationSent(db: D1Database, id: string, sendblueHandle: string | null): Promise<void> {
  await db
    .prepare(`UPDATE clarification SET status = 'sent', sent_at = ?, sendblue_handle = ? WHERE id = ?`)
    .bind(nowIso(), sendblueHandle, id)
    .run();
}

export async function markClarificationAnswered(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE clarification SET status = 'answered', answered_at = ? WHERE id = ?`).bind(nowIso(), id).run();
}

export async function markClarificationTimedOut(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE clarification SET status = 'timed_out', timed_out_at = ? WHERE id = ?`).bind(nowIso(), id).run();
}

/**
 * Every clarification the resolver should try to match a reply against —
 * "match against all open clarifications for that number, not just the
 * newest batch" (PLAN.md §5.2). Household-scoped, not per-user: every
 * clarification goes to the shared group thread, so a reply from either
 * spouse can answer anything open for the household, regardless of which
 * account owner the question was nominally addressed to.
 */
export async function listOpenClarificationsForHousehold(db: D1Database, householdId: string): Promise<Clarification[]> {
  const { results } = await db
    .prepare(`SELECT * FROM clarification WHERE household_id = ? AND status = 'sent' ORDER BY created_at`)
    .bind(householdId)
    .all<Clarification>();
  return results;
}

/** Asks the pipeline has created but nobody has sent yet — what the hourly
 * check-in (src/messaging/hourlyCheckin.ts) batches into one message.
 * Oldest first, so a message that can't fit them all asks about the
 * longest-waiting charges rather than an arbitrary subset. */
export async function listQueuedClarificationsForHousehold(db: D1Database, householdId: string): Promise<Clarification[]> {
  const { results } = await db
    .prepare(`SELECT * FROM clarification WHERE household_id = ? AND status = 'queued' ORDER BY created_at`)
    .bind(householdId)
    .all<Clarification>();
  return results;
}

export async function listQueuedClarifications(db: D1Database, status: ClarificationStatus = "queued"): Promise<Clarification[]> {
  const { results } = await db.prepare(`SELECT * FROM clarification WHERE status = ?`).bind(status).all<Clarification>();
  return results;
}

/** The most recent clarification on a transaction, answered or not — what
 * a "fix X" reply (PLAN.md §5.3) reopens. */
export async function getLatestClarificationForTransaction(
  db: D1Database,
  householdId: string,
  transactionId: string,
): Promise<Clarification | null> {
  return db
    .prepare(
      `SELECT * FROM clarification WHERE household_id = ? AND transaction_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(householdId, transactionId)
    .first<Clarification>();
}

export async function reopenClarification(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE clarification SET status = 'queued', answered_at = NULL WHERE id = ?`).bind(id).run();
}
