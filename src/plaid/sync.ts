import { getEncryptionKey, getPlaidConfig } from "../lib/secrets";
import { normalizeMerchant } from "../lib/merchant";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { AccountType, Env } from "../types";
import { ensureDefaultIncomeRule } from "../categorization/defaultIncomeRule";
import {
  createAccount,
  getAccountByPlaidAccountId,
  markAccountsLoginRequiredForItem,
  reactivateAccountsForItem,
  updateAccountBalance,
} from "../db/accounts";
import {
  getPlaidAccessToken,
  getPlaidItemByPlaidId,
  setPlaidItemStatus,
  updateSyncCursor,
} from "../db/plaidItems";
import {
  carryPendingToPosted,
  createTransaction,
  getTransactionByPlaidTxnId,
  removeTransactionByPlaidTxnId,
  updateTransactionFieldsFromPlaid,
} from "../db/transactions";
import { detectAndMarkTransfer } from "../db/transfers";
import { transactionsSyncPage } from "./client";
import type { PlaidAccount, PlaidTransaction } from "./types";

/** Plaid: positive amount = money out. This codebase: negative = money
 * out (src/types.ts). Every transaction crossing the boundary flips sign
 * exactly once, here. */
function toAmountCents(plaidAmount: number): number {
  return -Math.round(plaidAmount * 100);
}

function toCentsOrNull(dollars: number | null): number | null {
  return dollars === null ? null : Math.round(dollars * 100);
}

function mapAccountType(account: PlaidAccount): AccountType {
  if (account.type === "credit") return "credit_card";
  if (account.type === "depository") {
    return account.subtype === "savings" ? "depository_savings" : "depository_checking";
  }
  return "other";
}

async function ensureAccountsExist(
  db: D1Database,
  householdId: string,
  plaidItemId: string,
  accounts: PlaidAccount[],
): Promise<void> {
  for (const plaidAccount of accounts) {
    const existing = await getAccountByPlaidAccountId(db, plaidAccount.account_id);
    const accountId = existing
      ? existing.id
      : (
          await createAccount(db, householdId, {
            name: plaidAccount.name,
            type: mapAccountType(plaidAccount),
            mask: plaidAccount.mask,
            plaidItemId,
            plaidAccountId: plaidAccount.account_id,
          })
        ).id;

    await updateAccountBalance(db, accountId, toCentsOrNull(plaidAccount.balances.current), toCentsOrNull(plaidAccount.balances.available));
  }
}

interface AppliedTransaction {
  transactionId: string;
  accountId: string;
  amountCents: number;
  postedAt: string;
  isNew: boolean;
}

/**
 * Upserts one Plaid transaction, handling all three cases from PLAN.md
 * §4.2: a brand new row, a re-delivered `modified` update (fields change,
 * category/memo never touched), and the pending→posted transition (the
 * existing row is renamed onto the new plaid_txn_id rather than
 * duplicated, carrying its category/memo/clarification history).
 */
async function applyPlaidTransaction(
  db: D1Database,
  householdId: string,
  plaidTxn: PlaidTransaction,
): Promise<AppliedTransaction | null> {
  const account = await getAccountByPlaidAccountId(db, plaidTxn.account_id);
  if (!account) return null; // ensureAccountsExist runs first in the caller's loop; this would mean an unlinked account

  const amountCents = toAmountCents(plaidTxn.amount);
  const normalizedMerchant = normalizeMerchant(plaidTxn.merchant_name ?? plaidTxn.name);

  if (plaidTxn.pending_transaction_id) {
    const pendingRow = await getTransactionByPlaidTxnId(db, plaidTxn.pending_transaction_id);
    if (pendingRow) {
      await carryPendingToPosted(db, pendingRow.id, {
        newPlaidTxnId: plaidTxn.transaction_id,
        postedAt: plaidTxn.date,
        amountCents,
        rawDescription: plaidTxn.name,
        normalizedMerchant,
      });
      return { transactionId: pendingRow.id, accountId: account.id, amountCents, postedAt: plaidTxn.date, isNew: false };
    }
    // Unmatched pending→posted pair (PLAN.md §4.2) — fall through to a
    // normal upsert. merchant_memory already learned this merchant from
    // the pending ask, so re-categorization is usually silent.
  }

  const existing = await getTransactionByPlaidTxnId(db, plaidTxn.transaction_id);
  if (existing) {
    await updateTransactionFieldsFromPlaid(db, existing.id, {
      postedAt: plaidTxn.date,
      amountCents,
      rawDescription: plaidTxn.name,
      normalizedMerchant,
      pending: plaidTxn.pending,
    });
    return { transactionId: existing.id, accountId: account.id, amountCents, postedAt: plaidTxn.date, isNew: false };
  }

  const created = await createTransaction(db, householdId, {
    accountId: account.id,
    postedAt: plaidTxn.date,
    amountCents,
    rawDescription: plaidTxn.name,
    normalizedMerchant,
    plaidTxnId: plaidTxn.transaction_id,
    pending: plaidTxn.pending,
    source: "plaid",
  });
  return { transactionId: created.id, accountId: account.id, amountCents, postedAt: plaidTxn.date, isNew: true };
}

/**
 * A null cursor means this item has never synced before — Plaid's first
 * /transactions/sync response for a brand-new item is a historical
 * backfill (often 12-24 months, PLAN.md §4.2), not a stream of live
 * charges. Every transaction from that call, however many pages it takes,
 * is backfill; a later sync (cursor already set) is the real thing.
 * Getting this wrong means texting someone individually about every
 * unrecognized transaction from the last two years the moment they link a
 * card — pulled out as its own named, tested predicate for exactly that
 * reason, rather than an inline comparison easy to flip by accident in a
 * future refactor.
 */
export function isInitialPlaidSync(cursorAtSyncStart: string | null): boolean {
  return cursorAtSyncStart === null;
}

/** Runs one full /transactions/sync cycle for an item — every page until
 * has_more is false, persisting the cursor after each page so a crash
 * mid-sync resumes rather than re-processing from scratch (PLAN.md §4.2). */
export async function syncPlaidItem(env: Env, householdId: string, plaidItemId: string): Promise<void> {
  const plaidConfig = getPlaidConfig(env);
  const encryptionKey = await getEncryptionKey(env);

  const item = await getPlaidItemByPlaidId(env.DB, plaidItemId);
  if (!item || item.household_id !== householdId || item.status !== "active") return;
  const accessToken = await getPlaidAccessToken(item, encryptionKey);

  // Idempotent, and cheap once already present — ensures every deposit
  // this sync is about to see has somewhere to land instead of asking a
  // human "what was this $4,710?" for every paycheck (see
  // src/categorization/defaultIncomeRule.ts). Runs before any transaction
  // in this sync gets queued for categorization, including a household's
  // very first sync.
  await ensureDefaultIncomeRule(env.DB, householdId);

  // Captured once, up front — the loop below reassigns the local `cursor`
  // variable as it pages, so `item.cursor` is only reliable here.
  const isInitialSync = isInitialPlaidSync(item.cursor);

  let cursor = item.cursor;
  let hasMore = true;

  while (hasMore) {
    const page = await transactionsSyncPage(plaidConfig, accessToken, cursor);
    await ensureAccountsExist(env.DB, householdId, plaidItemId, page.accounts);

    for (const plaidTxn of [...page.added, ...page.modified]) {
      const applied = await applyPlaidTransaction(env.DB, householdId, plaidTxn);
      if (!applied) continue;

      const isTransfer = await detectAndMarkTransfer(env.DB, householdId, {
        id: applied.transactionId,
        accountId: applied.accountId,
        amountCents: applied.amountCents,
        postedAt: applied.postedAt,
      });

      if (!isTransfer && applied.isNew) {
        const message: TransactionQueueMessage = {
          type: "categorize",
          householdId,
          transactionId: applied.transactionId,
          skipClarification: isInitialSync,
        };
        await env.TRANSACTION_QUEUE.send(message);
      }
    }

    for (const removed of page.removed) {
      await removeTransactionByPlaidTxnId(env.DB, householdId, removed.transaction_id);
    }

    cursor = page.next_cursor;
    hasMore = page.has_more;
    await updateSyncCursor(env.DB, plaidItemId, cursor);
  }
}

/** ITEM webhooks (PLAN.md §4.1): catch ITEM_LOGIN_REQUIRED and surface a
 * re-link prompt instead of silently losing the account. */
export async function handleItemWebhook(env: Env, householdId: string, plaidItemId: string, webhookCode: string): Promise<void> {
  switch (webhookCode) {
    case "ITEM_LOGIN_REQUIRED":
    case "PENDING_EXPIRATION":
      await setPlaidItemStatus(env.DB, plaidItemId, "login_required");
      await markAccountsLoginRequiredForItem(env.DB, householdId, plaidItemId);
      break;
    case "LOGIN_REPAIRED":
      await setPlaidItemStatus(env.DB, plaidItemId, "active");
      await reactivateAccountsForItem(env.DB, householdId, plaidItemId);
      break;
    default:
      // NEW_ACCOUNTS_AVAILABLE, WEBHOOK_UPDATE_ACKNOWLEDGED, etc. — no
      // action needed; a plaid_sync job (already enqueued alongside this
      // one for TRANSACTIONS webhooks) covers new data.
      break;
  }
}
