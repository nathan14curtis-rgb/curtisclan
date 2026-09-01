/** Deterministic short digest, used as a synthetic idempotency key for
 * CSV-imported rows that have no plaid_txn_id (src/import/csvImport.ts) —
 * running the same import twice must not double-insert. */
export async function shortDigest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32);
}

/** Full-length SHA-256 hex digest — used to hash session tokens and login
 * codes before storing (src/lib/session.ts, src/db/loginCodes.ts): a DB
 * read alone must never hand back something directly usable as a
 * credential, same reasoning as Plaid token encryption (src/lib/crypto.ts). */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
