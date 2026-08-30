import { nowIso } from "./client";

export interface CachedWebhookKey {
  key_id: string;
  jwk: string; // JSON-serialized JWK
  expired_at: string | null;
  fetched_at: string;
}

/** A given kid's key content never changes, only eventually expires — safe
 * to cache indefinitely and just check expired_at on read (Plaid's own
 * guidance for /webhook_verification_key/get, PLAN.md §4.1). */
export async function getCachedWebhookKey(db: D1Database, keyId: string): Promise<CachedWebhookKey | null> {
  return db.prepare(`SELECT * FROM plaid_webhook_key_cache WHERE key_id = ?`).bind(keyId).first<CachedWebhookKey>();
}

export async function cacheWebhookKey(
  db: D1Database,
  keyId: string,
  jwk: unknown,
  expiredAt: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plaid_webhook_key_cache (key_id, jwk, expired_at, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET jwk = excluded.jwk, expired_at = excluded.expired_at, fetched_at = excluded.fetched_at`,
    )
    .bind(keyId, JSON.stringify(jwk), expiredAt, nowIso())
    .run();
}
