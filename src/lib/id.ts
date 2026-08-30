/** ULID-ish sortable id: millisecond timestamp prefix + random suffix, so
 * primary keys sort chronologically without a separate created_at index. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${prefix}_${ts}${rand}`;
}
