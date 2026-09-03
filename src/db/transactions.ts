import { newId } from "../lib/id";
import type { ClassificationMethod, Transaction, TransactionFlagColor, TransactionSource } from "../types";
import { getScoped, NotFoundError, nowIso } from "./client";
import { recordClassification } from "./classifications";
import { reinforceMerchantMemory } from "./merchantMemory";

export interface CreateTransactionInput {
  accountId: string;
  postedAt: string;
  amountCents: number;
  rawDescription: string;
  normalizedMerchant?: string | null;
  plaidTxnId?: string | null;
  pendingPlaidTxnId?: string | null;
  pending?: boolean;
  source?: TransactionSource;
}

export async function createTransaction(
  db: D1Database,
  householdId: string,
  input: CreateTransactionInput,
): Promise<Transaction> {
  const id = newId("txn");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO "transaction"
         (id, household_id, account_id, plaid_txn_id, pending_plaid_txn_id, posted_at, amount_cents, raw_description, normalized_merchant, pending, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      householdId,
      input.accountId,
      input.plaidTxnId ?? null,
      input.pendingPlaidTxnId ?? null,
      input.postedAt,
      input.amountCents,
      input.rawDescription,
      input.normalizedMerchant ?? null,
      input.pending ? 1 : 0,
      input.source ?? "plaid",
      now,
      now,
    )
    .run();

  return {
    id,
    household_id: householdId,
    account_id: input.accountId,
    plaid_txn_id: input.plaidTxnId ?? null,
    pending_plaid_txn_id: input.pendingPlaidTxnId ?? null,
    posted_at: input.postedAt,
    amount_cents: input.amountCents,
    raw_description: input.rawDescription,
    normalized_merchant: input.normalizedMerchant ?? null,
    category_id: null,
    memo: null,
    pending: input.pending ? 1 : 0,
    is_transfer: 0,
    excluded_from_budget: 0,
    split_parent_id: null,
    source: input.source ?? "plaid",
    verified_by_user_id: null,
    verified_at: null,
    flag_color: null,
    created_at: now,
    updated_at: now,
  };
}

export async function getTransaction(db: D1Database, householdId: string, id: string): Promise<Transaction> {
  return getScoped<Transaction>(db, "transaction", householdId, id);
}

export interface ListTransactionsFilter {
  accountId?: string;
  categoryId?: string;
  fromDate?: string; // inclusive, posted_at
  toDate?: string; // inclusive, posted_at
  needsReview?: boolean; // category_id IS NULL
  limit?: number;
}

/** Shared by listTransactions and listTransactionsWithVerifyState so the
 * two never drift apart on what a filter means. */
function buildTransactionFilterClauses(householdId: string, filter: ListTransactionsFilter, columnPrefix = ""): { clauses: string[]; params: unknown[] } {
  const clauses = [`${columnPrefix}household_id = ?`];
  const params: unknown[] = [householdId];

  if (filter.accountId) {
    clauses.push(`${columnPrefix}account_id = ?`);
    params.push(filter.accountId);
  }
  if (filter.categoryId) {
    clauses.push(`${columnPrefix}category_id = ?`);
    params.push(filter.categoryId);
  }
  if (filter.fromDate) {
    clauses.push(`${columnPrefix}posted_at >= ?`);
    params.push(filter.fromDate);
  }
  if (filter.toDate) {
    clauses.push(`${columnPrefix}posted_at <= ?`);
    params.push(filter.toDate);
  }
  if (filter.needsReview) {
    clauses.push(`${columnPrefix}category_id IS NULL`);
  }
  return { clauses, params };
}

export async function listTransactions(
  db: D1Database,
  householdId: string,
  filter: ListTransactionsFilter = {},
): Promise<Transaction[]> {
  const { clauses, params } = buildTransactionFilterClauses(householdId, filter);
  const limit = Math.min(filter.limit ?? 200, 1000);
  const { results } = await db
    .prepare(
      `SELECT * FROM "transaction" WHERE ${clauses.join(" AND ")} ORDER BY posted_at DESC LIMIT ?`,
    )
    .bind(...params, limit)
    .all<Transaction>();
  return results;
}

export type VerifyState = "me" | "ai" | "none";
const AUTO_VERIFY_METHODS = new Set<ClassificationMethod>(["rule", "memory", "llm"]);

export interface TransactionWithVerifyState extends Transaction {
  verify_state: VerifyState;
}

/** An explicit human action, recorded directly on the row (unlike
 * category, which is corrected through applyCategorization + the audit
 * trail) — "verified" is a stronger, distinct claim from "the category
 * happens to be correct." */
export async function verifyTransaction(db: D1Database, householdId: string, id: string, verifiedByUserId: string): Promise<Transaction> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE "transaction" SET verified_by_user_id = ?, verified_at = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(verifiedByUserId, now, now, id, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", id);
  return getTransaction(db, householdId, id);
}

export async function unverifyTransaction(db: D1Database, householdId: string, id: string): Promise<Transaction> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE "transaction" SET verified_by_user_id = NULL, verified_at = NULL, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(now, id, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", id);
  return getTransaction(db, householdId, id);
}

/**
 * Derived, not stored — except the "me" signal, which is the real
 * verified_by_user_id column. "ai" reflects the existing
 * transaction_classification audit trail (latest method IN
 * rule/memory/llm) rather than a second, potentially-conflicting source of
 * truth: a transaction someone recategorized by hand in the dropdown
 * (method='human') without ever clicking "verify" shows as "none", not
 * "ai" — verification is a stronger, explicit claim than "the category
 * happens to be right."
 *
 * One query for the whole list, not one per transaction — a correlated
 * subquery picks each transaction's most recent classification method.
 */
export async function listTransactionsWithVerifyState(
  db: D1Database,
  householdId: string,
  filter: ListTransactionsFilter = {},
): Promise<TransactionWithVerifyState[]> {
  const { clauses, params } = buildTransactionFilterClauses(householdId, filter, "t.");
  const limit = Math.min(filter.limit ?? 200, 1000);
  const { results } = await db
    .prepare(
      `SELECT t.*,
         (SELECT method FROM transaction_classification tc WHERE tc.transaction_id = t.id ORDER BY tc.created_at DESC, tc.id DESC LIMIT 1) AS latest_method
       FROM "transaction" t
       WHERE ${clauses.join(" AND ")} ORDER BY t.posted_at DESC LIMIT ?`,
    )
    .bind(...params, limit)
    .all<Transaction & { latest_method: ClassificationMethod | null }>();

  return results.map(({ latest_method, ...t }) => ({
    ...t,
    verify_state: t.verified_by_user_id ? "me" : latest_method && AUTO_VERIFY_METHODS.has(latest_method) ? "ai" : "none",
  }));
}

export interface ApplyCategorizationInput {
  categoryId: string;
  memo?: string | null;
  method: ClassificationMethod;
  confidence?: number | null;
  model?: string | null;
  reasoning?: string | null;
  alternatives?: unknown;
  promptVersion?: string | null;
  ruleId?: string | null;
  createdByUserId?: string | null;
}

/**
 * The single write path for "this transaction is now categorized as X" —
 * used by the rules engine, the merchant-memory layer, the LLM layer, and
 * both the iMessage reply resolver and a manual dashboard edit.
 *
 * Every call does three things: updates the transaction row, appends a
 * transaction_classification audit row (with the prior category, so a
 * correction is visible as a correction), and — only for method='human',
 * a human confirming or correcting the record — reinforces merchant_memory.
 * A dashboard edit must teach the system exactly as much as a text reply
 * does (PLAN.md §9, §5.5); routing every caller through this function is
 * what guarantees that instead of relying on each call site to remember.
 */
export async function applyCategorization(
  db: D1Database,
  householdId: string,
  transactionId: string,
  input: ApplyCategorizationInput,
): Promise<Transaction> {
  const existing = await getTransaction(db, householdId, transactionId);
  const now = nowIso();

  const result = await db
    .prepare(
      `UPDATE "transaction" SET category_id = ?, memo = COALESCE(?, memo), updated_at = ?
       WHERE id = ? AND household_id = ?`,
    )
    .bind(input.categoryId, input.memo ?? null, now, transactionId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", transactionId);

  await recordClassification(db, householdId, {
    transactionId,
    method: input.method,
    categoryId: input.categoryId,
    priorCategoryId: existing.category_id,
    confidence: input.confidence,
    model: input.model,
    reasoning: input.reasoning,
    alternatives: input.alternatives,
    promptVersion: input.promptVersion,
    ruleId: input.ruleId,
    createdByUserId: input.createdByUserId,
  });

  if (input.method === "human" && existing.normalized_merchant) {
    await reinforceMerchantMemory(
      db,
      householdId,
      existing.normalized_merchant,
      input.categoryId,
      existing.amount_cents,
    );
  }

  return { ...existing, category_id: input.categoryId, memo: input.memo ?? existing.memo, updated_at: now };
}

/**
 * Resets a transaction back to uncategorized — the dashboard's verify
 * toggle uses this when switching a transaction from "ai" (an unconfirmed
 * automatic guess) back off: rather than leave a category on the record
 * that nobody actually confirmed, clear it so the transaction goes back to
 * needing review. Distinct from unverifyTransaction, which only clears the
 * human-confirmation columns and leaves the category alone — this clears
 * the category itself and appends an audit row (method='human', the
 * household member doing the toggling) so the reset is visible in the
 * transaction_classification trail like any other correction.
 */
export async function clearCategorization(db: D1Database, householdId: string, transactionId: string, clearedByUserId?: string | null): Promise<Transaction> {
  const existing = await getTransaction(db, householdId, transactionId);
  const now = nowIso();

  const result = await db
    .prepare(`UPDATE "transaction" SET category_id = NULL, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(now, transactionId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", transactionId);

  if (existing.category_id) {
    await recordClassification(db, householdId, {
      transactionId,
      method: "human",
      categoryId: null,
      priorCategoryId: existing.category_id,
      createdByUserId: clearedByUserId,
    });
  }

  return { ...existing, category_id: null, updated_at: now };
}

export interface MerchantActivitySummary {
  merchant: string;
  count: number;
  avgAmountCents: number;
  kind: "expense" | "income";
}

/**
 * Aggregated (never row-level) merchant activity for uncategorized
 * transactions — the input to the AI category-suggestion feature
 * (src/categorization/categorySuggestions.ts). Same privacy boundary as
 * the categorization LLM calls: merchant name, count, and an average
 * amount, nothing else about the transaction or account.
 */
export async function listUncategorizedMerchantSummary(db: D1Database, householdId: string): Promise<MerchantActivitySummary[]> {
  const { results } = await db
    .prepare(
      `SELECT COALESCE(normalized_merchant, raw_description) AS merchant,
              COUNT(*) AS count,
              AVG(amount_cents) AS avg_amount_cents,
              CASE WHEN AVG(amount_cents) < 0 THEN 'expense' ELSE 'income' END AS kind
         FROM "transaction"
        WHERE household_id = ? AND category_id IS NULL AND is_transfer = 0
        GROUP BY merchant
        HAVING COUNT(*) >= 1
        ORDER BY count DESC
        LIMIT 40`,
    )
    .bind(householdId)
    .all<{ merchant: string; count: number; avg_amount_cents: number; kind: "expense" | "income" }>();
  return results.map((r) => ({ merchant: r.merchant, count: r.count, avgAmountCents: Math.round(r.avg_amount_cents), kind: r.kind }));
}

/** Recently categorized transactions (auto or otherwise), most recent
 * first — feeds both the morning digest (src/messaging/dailyDigest.ts)
 * and the "reply without 'fix'" correction pool
 * (src/messaging/inboundProcessing.ts), which needs a candidate list to
 * match a free-text correction against even when nothing is still open. */
export async function listRecentlyCategorizedTransactions(
  db: D1Database,
  householdId: string,
  sinceIso: string,
  limit = 25,
): Promise<Transaction[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM "transaction"
         WHERE household_id = ? AND category_id IS NOT NULL AND is_transfer = 0 AND excluded_from_budget = 0
           AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(householdId, sinceIso, limit)
    .all<Transaction>();
  return results;
}

/** Excludes a transaction from every envelope-balance/spend total without
 * touching its category — for a reimbursed purchase, a transfer the
 * transfer-detector missed, or anything else that shouldn't count against
 * the budget but is still worth keeping on the books. */
export async function setTransactionExcluded(db: D1Database, householdId: string, id: string, excluded: boolean): Promise<Transaction> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE "transaction" SET excluded_from_budget = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(excluded ? 1 : 0, now, id, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", id);
  return getTransaction(db, householdId, id);
}

export interface EditTransactionInput {
  categoryId: string;
  amountCents: number;
  editedByUserId?: string | null;
}

/**
 * The dashboard's pencil-edit flow (Transactions page): a household member
 * corrects the category and the amount in one save. Saving counts as
 * verifying the row — the same explicit human confirmation the standalone
 * verify control records, just folded into the one action instead of two.
 */
export async function editTransaction(
  db: D1Database,
  householdId: string,
  transactionId: string,
  input: EditTransactionInput,
): Promise<Transaction> {
  const categorized = await applyCategorization(db, householdId, transactionId, {
    categoryId: input.categoryId,
    method: "human",
    createdByUserId: input.editedByUserId,
  });

  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE "transaction" SET amount_cents = ?, verified_by_user_id = ?, verified_at = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`,
    )
    .bind(input.amountCents, input.editedByUserId ?? null, input.editedByUserId ? now : null, now, transactionId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", transactionId);

  return {
    ...categorized,
    amount_cents: input.amountCents,
    verified_by_user_id: input.editedByUserId ?? null,
    verified_at: input.editedByUserId ? now : null,
    updated_at: now,
  };
}

/** A purely visual marker a household member sets by hand — never touched
 * by categorization or verification, so it survives both untouched. */
export async function setTransactionFlag(db: D1Database, householdId: string, id: string, color: TransactionFlagColor | null): Promise<Transaction> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE "transaction" SET flag_color = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(color, now, id, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("transaction", id);
  return getTransaction(db, householdId, id);
}

/** Costco is groceries + household + a gift — splits are child rows, not a
 * forced single category (PLAN.md §3). The parent stays as the original
 * transaction (excluded from budget totals by the caller once split) and
 * each child carries its own amount, category, and memo. Split amounts
 * must sum to the parent's amount_cents exactly, in cents, no rounding. */
export async function splitTransaction(
  db: D1Database,
  householdId: string,
  parentId: string,
  splits: Array<{ amountCents: number; categoryId: string; memo?: string | null }>,
): Promise<Transaction[]> {
  const parent = await getTransaction(db, householdId, parentId);
  const sum = splits.reduce((total, s) => total + s.amountCents, 0);
  if (sum !== parent.amount_cents) {
    throw new Error(
      `split amounts (${sum}) must sum to parent amount (${parent.amount_cents}) exactly`,
    );
  }

  const created: Transaction[] = [];
  for (const split of splits) {
    const child = await createTransaction(db, householdId, {
      accountId: parent.account_id,
      postedAt: parent.posted_at,
      amountCents: split.amountCents,
      rawDescription: parent.raw_description,
      normalizedMerchant: parent.normalized_merchant,
      source: parent.source,
    });
    await db
      .prepare(`UPDATE "transaction" SET split_parent_id = ?, category_id = ?, memo = ? WHERE id = ?`)
      .bind(parentId, split.categoryId, split.memo ?? null, child.id)
      .run();
    created.push({ ...child, split_parent_id: parentId, category_id: split.categoryId, memo: split.memo ?? null });
  }

  // The parent stays on the books as the ledger's link to the account
  // statement, but its own amount must not double-count once children
  // carry the spend — exclude it from budget math instead of deleting it.
  await db
    .prepare(`UPDATE "transaction" SET excluded_from_budget = 1, updated_at = ? WHERE id = ?`)
    .bind(nowIso(), parentId)
    .run();

  return created;
}

/** Few-shot context for the LLM layer (PLAN.md §6): "5-10 similar past
 * transactions with their final categories." Same merchant, already
 * categorized, most recent first. */
export async function listRecentCategorizedByMerchant(
  db: D1Database,
  householdId: string,
  normalizedMerchant: string,
  limit = 5,
): Promise<Transaction[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM "transaction"
         WHERE household_id = ? AND normalized_merchant = ? AND category_id IS NOT NULL
         ORDER BY posted_at DESC LIMIT ?`,
    )
    .bind(householdId, normalizedMerchant, limit)
    .all<Transaction>();
  return results;
}

/** Backs the "fix X" correction flow (PLAN.md §5.3): the most recent
 * categorized transaction whose merchant or description contains the
 * given text, case-insensitive. */
export async function findRecentTransactionByMerchantSubstring(
  db: D1Database,
  householdId: string,
  needle: string,
  limit = 30,
): Promise<Transaction | null> {
  const { results } = await db
    .prepare(
      `SELECT * FROM "transaction"
         WHERE household_id = ? AND category_id IS NOT NULL
         ORDER BY posted_at DESC LIMIT ?`,
    )
    .bind(householdId, limit)
    .all<Transaction>();

  const lowerNeedle = needle.toLowerCase();
  return (
    results.find(
      (t) => (t.normalized_merchant ?? "").toLowerCase().includes(lowerNeedle) || t.raw_description.toLowerCase().includes(lowerNeedle),
    ) ?? null
  );
}

export async function getTransactionByPlaidTxnId(db: D1Database, plaidTxnId: string): Promise<Transaction | null> {
  return db.prepare(`SELECT * FROM "transaction" WHERE plaid_txn_id = ?`).bind(plaidTxnId).first<Transaction>();
}

/** A Plaid `modified` entry, or a re-delivered `added` entry — same fields
 * change either way, and category/memo are never touched here (PLAN.md
 * §4.2: the category must survive an amount correction). */
export async function updateTransactionFieldsFromPlaid(
  db: D1Database,
  transactionId: string,
  fields: { postedAt: string; amountCents: number; rawDescription: string; normalizedMerchant: string | null; pending: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE "transaction"
         SET posted_at = ?, amount_cents = ?, raw_description = ?, normalized_merchant = ?, pending = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(fields.postedAt, fields.amountCents, fields.rawDescription, fields.normalizedMerchant, fields.pending ? 1 : 0, nowIso(), transactionId)
    .run();
}

/**
 * Plaid removes the pending transaction and returns a new posted one
 * carrying pending_transaction_id (PLAN.md §4.2). Rather than insert a new
 * row and lose the pending row's category/memo/clarification history,
 * this *renames* the existing row onto the new plaid_txn_id and updates
 * its posted fields in place — "carry the category across the
 * pending→posted transition," not re-ask about every transaction twice.
 */
export async function carryPendingToPosted(
  db: D1Database,
  transactionId: string,
  fields: { newPlaidTxnId: string; postedAt: string; amountCents: number; rawDescription: string; normalizedMerchant: string | null },
): Promise<void> {
  await db
    .prepare(
      `UPDATE "transaction"
         SET plaid_txn_id = ?, pending_plaid_txn_id = NULL, posted_at = ?, amount_cents = ?, raw_description = ?, normalized_merchant = ?, pending = 0, updated_at = ?
       WHERE id = ?`,
    )
    .bind(fields.newPlaidTxnId, fields.postedAt, fields.amountCents, fields.rawDescription, fields.normalizedMerchant, nowIso(), transactionId)
    .run();
}

/** A transaction Plaid reports as truly removed (not a pending→posted
 * carry-over, which never reaches this function — see carryPendingToPosted).
 * Clears its audit/clarification children first since D1 enforces the
 * foreign keys referencing transaction(id). */
export async function removeTransactionByPlaidTxnId(db: D1Database, householdId: string, plaidTxnId: string): Promise<void> {
  const existing = await getTransactionByPlaidTxnId(db, plaidTxnId);
  if (!existing || existing.household_id !== householdId) return;

  await db.batch([
    db.prepare(`DELETE FROM transaction_classification WHERE transaction_id = ?`).bind(existing.id),
    db.prepare(`DELETE FROM clarification WHERE transaction_id = ?`).bind(existing.id),
    db.prepare(`DELETE FROM "transaction" WHERE id = ?`).bind(existing.id),
  ]);
}

/**
 * Wipes every transaction on one account, with its audit/clarification
 * children — the "delete transactions" half of unlinking an account
 * (src/plaid/unlink.ts). Unlike removeTransactionByPlaidTxnId (a single
 * row Plaid tells us is gone), this is a deliberate bulk purge the caller
 * asked for explicitly, e.g. clearing out a Sandbox-linked test account's
 * fake history before linking the real one. Returns the count deleted so
 * the caller can report it back.
 */
export async function deleteTransactionsForAccount(db: D1Database, householdId: string, accountId: string): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id FROM "transaction" WHERE household_id = ? AND account_id = ?`)
    .bind(householdId, accountId)
    .all<{ id: string }>();
  if (results.length === 0) return 0;

  const ids = results.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  await db.batch([
    db.prepare(`DELETE FROM transaction_classification WHERE transaction_id IN (${placeholders})`).bind(...ids),
    db.prepare(`DELETE FROM clarification WHERE transaction_id IN (${placeholders})`).bind(...ids),
    db.prepare(`DELETE FROM "transaction" WHERE id IN (${placeholders})`).bind(...ids),
  ]);
  return ids.length;
}
