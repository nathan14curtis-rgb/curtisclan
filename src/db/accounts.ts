import { newId } from "../lib/id";
import type { Account, AccountStatus, AccountType } from "../types";
import { getScoped, listScoped, nowIso } from "./client";

export async function listAccounts(db: D1Database, householdId: string): Promise<Account[]> {
  return listScoped<Account>(db, "account", householdId, "name");
}

export async function getAccount(db: D1Database, householdId: string, id: string): Promise<Account> {
  return getScoped<Account>(db, "account", householdId, id);
}

export async function getAccountByPlaidAccountId(db: D1Database, plaidAccountId: string): Promise<Account | null> {
  return db.prepare(`SELECT * FROM account WHERE plaid_account_id = ?`).bind(plaidAccountId).first<Account>();
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
    status: "active",
    current_balance_cents: null,
    available_balance_cents: null,
    balance_updated_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Rename, reassign the card's owner (including to nobody, for a joint
 * account), or mark it 'removed' — the dashboard settings surface for an
 * account that isn't Plaid-linked/re-link management (that's the sandbox
 * fire-webhook / Link flow instead). `ownerUserId: null` clears the owner;
 * omitting it leaves the current owner untouched. */
export async function updateAccount(
  db: D1Database,
  householdId: string,
  id: string,
  input: { name?: string; ownerUserId?: string | null; status?: AccountStatus },
): Promise<Account> {
  const existing = await getAccount(db, householdId, id);
  const name = input.name ?? existing.name;
  const ownerUserId = "ownerUserId" in input ? (input.ownerUserId ?? null) : existing.owner_user_id;
  const status = input.status ?? existing.status;
  const now = nowIso();
  await db
    .prepare(`UPDATE account SET name = ?, owner_user_id = ?, status = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(name, ownerUserId, status, now, id, householdId)
    .run();
  return { ...existing, name, owner_user_id: ownerUserId, status, updated_at: now };
}

/** Refreshed on every sync — feeds the Ready-to-Assign credit-card
 * correction (PLAN.md §8.3.1), which needs live account balances, not
 * just the transaction ledger. */
export async function updateAccountBalance(
  db: D1Database,
  accountId: string,
  currentBalanceCents: number | null,
  availableBalanceCents: number | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE account SET current_balance_cents = ?, available_balance_cents = ?, balance_updated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(currentBalanceCents, availableBalanceCents, nowIso(), nowIso(), accountId)
    .run();
}

/** Plaid signals a broken item via ITEM_LOGIN_REQUIRED (PLAN.md §4.1). Every
 * account under that item shares the outage, so all of them flip together —
 * skip this and the dashboard silently stops seeing a card while showing
 * it as healthy. */
export async function markAccountsLoginRequiredForItem(
  db: D1Database,
  householdId: string,
  plaidItemId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE account SET status = 'login_required', updated_at = ? WHERE household_id = ? AND plaid_item_id = ?`)
    .bind(nowIso(), householdId, plaidItemId)
    .run();
}

export async function reactivateAccountsForItem(db: D1Database, householdId: string, plaidItemId: string): Promise<void> {
  await db
    .prepare(`UPDATE account SET status = 'active', updated_at = ? WHERE household_id = ? AND plaid_item_id = ?`)
    .bind(nowIso(), householdId, plaidItemId)
    .run();
}
