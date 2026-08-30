/** Deterministic short digest, used as a synthetic idempotency key for
 * CSV-imported rows that have no plaid_txn_id (src/import/csvImport.ts) —
 * running the same import twice must not double-insert. */
export async function shortDigest(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 32);
}
