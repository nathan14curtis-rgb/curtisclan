/**
 * Household-scoped data access (PLAN.md §10: "household-scoped queries at
 * the data layer, not by remembering a WHERE clause").
 *
 * Every read/write helper in src/db/* takes householdId as an explicit,
 * required argument and bakes it into the SQL itself — there is no code
 * path in this layer that queries a household-owned table without it.
 * Route handlers never write raw SQL against these tables; they call these
 * helpers instead.
 */

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

/** Fetches one row scoped to a household. Throws NotFoundError if the row
 * doesn't exist *or* belongs to a different household — the caller can't
 * distinguish "wrong id" from "someone else's data" from the outside. */
export async function getScoped<T>(
  db: D1Database,
  table: string,
  householdId: string,
  id: string,
): Promise<T> {
  const row = await db
    .prepare(`SELECT * FROM "${table}" WHERE id = ? AND household_id = ?`)
    .bind(id, householdId)
    .first<T>();
  if (!row) throw new NotFoundError(table, id);
  return row;
}

export async function listScoped<T>(
  db: D1Database,
  table: string,
  householdId: string,
  orderBy = "created_at",
): Promise<T[]> {
  const { results } = await db
    .prepare(`SELECT * FROM "${table}" WHERE household_id = ? ORDER BY ${orderBy}`)
    .bind(householdId)
    .all<T>();
  return results;
}

/** now() in the same ISO-8601 form the SQL schema's DEFAULT (datetime('now')) produces. */
export function nowIso(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}
