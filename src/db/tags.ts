/**
 * Tags — free-form labels orthogonal to category (docs/SPENDING_PLAN_EDITING.md
 * phase 1). A transaction has exactly one category but any number of tags:
 * "vacation", "reimbursable", "tax-deductible" cut across the spending
 * plan rather than sitting inside it.
 */

import { newId } from "../lib/id";
import type { Tag } from "../types";
import { NotFoundError, nowIso } from "./client";

export async function listTags(db: D1Database, householdId: string): Promise<Tag[]> {
  const { results } = await db.prepare(`SELECT * FROM tag WHERE household_id = ? ORDER BY name`).bind(householdId).all<Tag>();
  return results;
}

/** Create, or hand back the existing tag of that name — a household can't
 * have two "vacation" tags, and racing two devices to create one should
 * settle on the same row rather than failing the second caller. */
export async function createTag(db: D1Database, householdId: string, input: { name: string; color?: string | null }): Promise<Tag> {
  const name = input.name.trim();
  if (!name) throw new Error("tag name cannot be blank");
  const existing = await db.prepare(`SELECT * FROM tag WHERE household_id = ? AND name = ?`).bind(householdId, name).first<Tag>();
  if (existing) return existing;

  const tag: Tag = { id: newId("tag"), household_id: householdId, name, color: input.color ?? null, created_at: nowIso() };
  await db
    .prepare(`INSERT INTO tag (id, household_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(tag.id, householdId, tag.name, tag.color, tag.created_at)
    .run();
  return tag;
}

export async function updateTag(db: D1Database, householdId: string, id: string, input: { name?: string; color?: string | null }): Promise<Tag> {
  const existing = await db.prepare(`SELECT * FROM tag WHERE id = ? AND household_id = ?`).bind(id, householdId).first<Tag>();
  if (!existing) throw new NotFoundError("tag", id);
  const name = input.name?.trim() || existing.name;
  const color = "color" in input ? (input.color ?? null) : existing.color;
  await db.prepare(`UPDATE tag SET name = ?, color = ? WHERE id = ? AND household_id = ?`).bind(name, color, id, householdId).run();
  return { ...existing, name, color };
}

/** Deleting a tag unfiles it from every transaction (the join rows cascade),
 * which is the point — a tag nobody uses shouldn't linger in the picker. */
export async function deleteTag(db: D1Database, householdId: string, id: string): Promise<void> {
  const result = await db.prepare(`DELETE FROM tag WHERE id = ? AND household_id = ?`).bind(id, householdId).run();
  if (result.meta.changes === 0) throw new NotFoundError("tag", id);
}

export async function listTagsForTransaction(db: D1Database, householdId: string, transactionId: string): Promise<Tag[]> {
  const { results } = await db
    .prepare(
      `SELECT t.* FROM tag t
         JOIN transaction_tag tt ON tt.tag_id = t.id
        WHERE tt.transaction_id = ? AND t.household_id = ?
        ORDER BY t.name`,
    )
    .bind(transactionId, householdId)
    .all<Tag>();
  return results;
}

/** Every transaction's tags in one query, for a page that renders a list —
 * the per-row alternative is an N+1 the dashboard would feel. */
export async function listTagsByTransaction(db: D1Database, householdId: string): Promise<Record<string, Tag[]>> {
  const { results } = await db
    .prepare(
      `SELECT tt.transaction_id AS transaction_id, t.* FROM tag t
         JOIN transaction_tag tt ON tt.tag_id = t.id
        WHERE t.household_id = ?
        ORDER BY t.name`,
    )
    .bind(householdId)
    .all<Tag & { transaction_id: string }>();

  const byTransaction: Record<string, Tag[]> = {};
  for (const row of results) {
    const { transaction_id, ...tag } = row;
    (byTransaction[transaction_id] ??= []).push(tag);
  }
  return byTransaction;
}

/**
 * Replace a transaction's whole tag set in one write — the detail modal
 * hands back what the tags should be, not a diff, so this is a set
 * operation. Names that don't exist yet become tags (typing a new tag in
 * the picker is how tags get created in practice).
 */
export async function setTransactionTags(
  db: D1Database,
  householdId: string,
  transactionId: string,
  input: { tagIds?: string[]; tagNames?: string[] },
): Promise<Tag[]> {
  const ids = new Set(input.tagIds ?? []);
  for (const name of input.tagNames ?? []) {
    if (!name.trim()) continue;
    const tag = await createTag(db, householdId, { name });
    ids.add(tag.id);
  }

  // Only tags this household owns — an id from another household must not
  // become a join row, which is why this re-reads rather than trusting the
  // input.
  const owned = new Set((await listTags(db, householdId)).map((t) => t.id));
  const finalIds = [...ids].filter((id) => owned.has(id));

  const writes: D1PreparedStatement[] = [db.prepare(`DELETE FROM transaction_tag WHERE transaction_id = ?`).bind(transactionId)];
  for (const tagId of finalIds) {
    writes.push(
      db.prepare(`INSERT INTO transaction_tag (transaction_id, tag_id, created_at) VALUES (?, ?, ?)`).bind(transactionId, tagId, nowIso()),
    );
  }
  await db.batch(writes);
  return listTagsForTransaction(db, householdId, transactionId);
}
