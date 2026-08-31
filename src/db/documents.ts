import { newId } from "../lib/id";
import type { Document, DocumentCategory } from "../types";
import { getScoped, nowIso } from "./client";

export interface ListDocumentsFilter {
  category?: DocumentCategory;
  assetId?: string;
}

export async function listDocuments(db: D1Database, householdId: string, filter: ListDocumentsFilter = {}): Promise<Document[]> {
  const clauses = ["household_id = ?", "archived_at IS NULL"];
  const params: unknown[] = [householdId];
  if (filter.category) {
    clauses.push("category = ?");
    params.push(filter.category);
  }
  if (filter.assetId) {
    clauses.push("asset_id = ?");
    params.push(filter.assetId);
  }
  const { results } = await db
    .prepare(`SELECT * FROM document WHERE ${clauses.join(" AND ")} ORDER BY name`)
    .bind(...params)
    .all<Document>();
  return results;
}

export async function getDocument(db: D1Database, householdId: string, id: string): Promise<Document> {
  return getScoped<Document>(db, "document", householdId, id);
}

export async function createDocument(
  db: D1Database,
  householdId: string,
  input: { name: string; category: DocumentCategory; assetId?: string | null; ownerUserId?: string | null; detail?: string | null },
): Promise<Document> {
  const id = newId("doc");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO document (id, household_id, asset_id, name, category, owner_user_id, detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.assetId ?? null, input.name, input.category, input.ownerUserId ?? null, input.detail ?? null, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    asset_id: input.assetId ?? null,
    name: input.name,
    category: input.category,
    owner_user_id: input.ownerUserId ?? null,
    detail: input.detail ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function updateDocument(
  db: D1Database,
  householdId: string,
  id: string,
  input: { name?: string; detail?: string | null; ownerUserId?: string | null; assetId?: string | null },
): Promise<Document> {
  const existing = await getDocument(db, householdId, id);
  const name = input.name ?? existing.name;
  const detail = "detail" in input ? (input.detail ?? null) : existing.detail;
  const ownerUserId = "ownerUserId" in input ? (input.ownerUserId ?? null) : existing.owner_user_id;
  const assetId = "assetId" in input ? (input.assetId ?? null) : existing.asset_id;
  const now = nowIso();
  await db
    .prepare(`UPDATE document SET name = ?, detail = ?, owner_user_id = ?, asset_id = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(name, detail, ownerUserId, assetId, now, id, householdId)
    .run();
  return { ...existing, name, detail, owner_user_id: ownerUserId, asset_id: assetId, updated_at: now };
}

/** Archive, never delete — matches asset's own convention. */
export async function archiveDocument(db: D1Database, householdId: string, id: string): Promise<Document> {
  const now = nowIso();
  await db.prepare(`UPDATE document SET archived_at = ?, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, now, id, householdId).run();
  return getDocument(db, householdId, id);
}
