import { newId } from "../lib/id";
import type { Household } from "../types";
import { NotFoundError, nowIso } from "./client";
import { seedDefaultCategories } from "./categories";

export async function createHousehold(
  db: D1Database,
  input: { name: string; timezone?: string },
): Promise<Household> {
  const id = newId("hh");
  const timezone = input.timezone ?? "America/Denver";
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO household (id, name, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, timezone, now, now)
    .run();

  // A household is useless without a starting category taxonomy — seed it
  // immediately so the dashboard and the categorization cascade have
  // somewhere to file the first transaction (PLAN.md §8, Phase 0 milestone).
  await seedDefaultCategories(db, id);

  return { id, name: input.name, timezone, created_at: now, updated_at: now };
}

export async function getHousehold(db: D1Database, id: string): Promise<Household> {
  const row = await db.prepare(`SELECT * FROM household WHERE id = ?`).bind(id).first<Household>();
  if (!row) throw new NotFoundError("household", id);
  return row;
}
