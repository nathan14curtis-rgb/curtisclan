import { newId } from "../lib/id";
import { encryptSecret, decryptSecret, type EncryptedValue } from "../lib/crypto";
import type { Account, AccountType } from "../types";
import { getScoped, listScoped, NotFoundError, nowIso } from "./client";

export async function listAccounts(db: D1Database, householdId: string): Promise<Account[]> {
  return listScoped<Account>(db, "account", householdId, "name");
}

export async function getAccount(db: D1Database, householdId: string, id: string): Promise<Account> {
  return getScoped<Account>(db, "account", householdId, id);
}

export interface CreateAccountInput {
  name: string;
  type: AccountType;
  mask?: string | null;
  ownerUserId?: string | null;
  plaidItemId?: string | null;
  plaidAccountId?: string | null;
}

export async function createAccount(
  db: D1Database,
  householdId: string,
  input: CreateAccountInput,
): Promise<Account> {
  const id = newId("acct");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO account (id, household_id, owner_user_id, name, type, mask, plaid_item_id, plaid_account_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(
      id,
      householdId,
      input.ownerUserId ?? null,
      input.name,
      input.type,
      input.mask ?? null,
      input.plaidItemId ?? null,
      input.plaidAccountId ?? null,
      now,
      now,
    )
    .run();
  return {
    id,
    household_id: householdId,
    owner_user_id: input.ownerUserId ?? null,
    name: input.name,
    type: input.type,
    mask: input.mask ?? null,
    plaid_item_id: input.plaidItemId ?? null,
    plaid_account_id: input.plaidAccountId ?? null,
    plaid_access_token_ciphertext: null,
    plaid_access_token_iv: null,
    status: "active",
    created_at: now,
    updated_at: now,
  };
}

/** Encrypts and stores a Plaid access_token. The plaintext token must never
 * be persisted or logged (PLAN.md §4.1, §10) — this is the only writer of
 * these two columns. */
export async function storeAccessToken(
  db: D1Database,
  householdId: string,
  accountId: string,
  accessToken: string,
  encryptionKey: CryptoKey,
): Promise<void> {
  const encrypted = await encryptSecret(accessToken, encryptionKey);
  const result = await db
    .prepare(
      `UPDATE account SET plaid_access_token_ciphertext = ?, plaid_access_token_iv = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`,
    )
    .bind(encrypted.ciphertext, encrypted.iv, nowIso(), accountId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("account", accountId);
}

export async function getAccessToken(
  db: D1Database,
  householdId: string,
  accountId: string,
  encryptionKey: CryptoKey,
): Promise<string> {
  const account = await getScoped<Account>(db, "account", householdId, accountId);
  if (!account.plaid_access_token_ciphertext || !account.plaid_access_token_iv) {
    throw new Error(`account ${accountId} has no stored access token`);
  }
  const encrypted: EncryptedValue = {
    ciphertext: account.plaid_access_token_ciphertext,
    iv: account.plaid_access_token_iv,
  };
  return decryptSecret(encrypted, encryptionKey);
}

/** Plaid signals a broken item via ITEM_LOGIN_REQUIRED (PLAN.md §4.1). Mark
 * it so the dashboard can surface a re-link prompt instead of silently
 * losing the account. */
export async function markLoginRequired(db: D1Database, householdId: string, accountId: string): Promise<void> {
  const result = await db
    .prepare(`UPDATE account SET status = 'login_required', updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(nowIso(), accountId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("account", accountId);
}
