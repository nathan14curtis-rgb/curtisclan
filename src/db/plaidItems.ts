import { newId } from "../lib/id";
import { decryptSecret, encryptSecret, type EncryptedValue } from "../lib/crypto";
import type { PlaidItem, PlaidItemStatus } from "../types";
import { getScoped, NotFoundError, nowIso } from "./client";

/** Encrypts and stores a Plaid access_token, keyed by Item (not account —
 * one item's token covers every account under it). The plaintext token
 * must never be persisted or logged (PLAN.md §4.1, §10); this is the only
 * writer of these two columns. */
export async function createPlaidItem(
  db: D1Database,
  householdId: string,
  input: { plaidItemId: string; accessToken: string; institutionName?: string | null },
  encryptionKey: CryptoKey,
): Promise<PlaidItem> {
  const encrypted = await encryptSecret(input.accessToken, encryptionKey);
  const id = newId("pitem");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO plaid_item (id, household_id, plaid_item_id, access_token_ciphertext, access_token_iv, institution_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .bind(id, householdId, input.plaidItemId, encrypted.ciphertext, encrypted.iv, input.institutionName ?? null, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    plaid_item_id: input.plaidItemId,
    access_token_ciphertext: encrypted.ciphertext,
    access_token_iv: encrypted.iv,
    institution_name: input.institutionName ?? null,
    status: "active",
    cursor: null,
    last_synced_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function getPlaidItemByPlaidId(db: D1Database, plaidItemId: string): Promise<PlaidItem | null> {
  return db.prepare(`SELECT * FROM plaid_item WHERE plaid_item_id = ?`).bind(plaidItemId).first<PlaidItem>();
}

export async function getPlaidItem(db: D1Database, householdId: string, id: string): Promise<PlaidItem> {
  return getScoped<PlaidItem>(db, "plaid_item", householdId, id);
}

export async function listActivePlaidItems(db: D1Database): Promise<PlaidItem[]> {
  const { results } = await db.prepare(`SELECT * FROM plaid_item WHERE status = 'active'`).all<PlaidItem>();
  return results;
}

export async function getPlaidAccessToken(item: PlaidItem, encryptionKey: CryptoKey): Promise<string> {
  const encrypted: EncryptedValue = { ciphertext: item.access_token_ciphertext, iv: item.access_token_iv };
  return decryptSecret(encrypted, encryptionKey);
}

export async function updateSyncCursor(db: D1Database, plaidItemId: string, cursor: string): Promise<void> {
  const now = nowIso();
  const result = await db
    .prepare(`UPDATE plaid_item SET cursor = ?, last_synced_at = ?, updated_at = ? WHERE plaid_item_id = ?`)
    .bind(cursor, now, now, plaidItemId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("plaid_item", plaidItemId);
}

export async function setPlaidItemStatus(db: D1Database, plaidItemId: string, status: PlaidItemStatus): Promise<void> {
  await db
    .prepare(`UPDATE plaid_item SET status = ?, updated_at = ? WHERE plaid_item_id = ?`)
    .bind(status, nowIso(), plaidItemId)
    .run();
}
