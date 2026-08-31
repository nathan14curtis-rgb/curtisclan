import { newId } from "../lib/id";
import type { Asset, AssetType } from "../types";
import { getScoped, nowIso } from "./client";

export async function listAssets(db: D1Database, householdId: string): Promise<Asset[]> {
  const { results } = await db
    .prepare(`SELECT * FROM asset WHERE household_id = ? AND archived_at IS NULL ORDER BY name`)
    .bind(householdId)
    .all<Asset>();
  return results;
}

export async function getAsset(db: D1Database, householdId: string, id: string): Promise<Asset> {
  return getScoped<Asset>(db, "asset", householdId, id);
}

export async function createAsset(
  db: D1Database,
  householdId: string,
  input: { name: string; type: AssetType; valueCents?: number | null; notes?: string | null },
): Promise<Asset> {
  const id = newId("ast");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO asset (id, household_id, name, type, value_cents, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.name, input.type, input.valueCents ?? null, input.notes ?? null, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    name: input.name,
    type: input.type,
    value_cents: input.valueCents ?? null,
    notes: input.notes ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Same omitted-vs-explicit-null convention as updateEnvelope/updateAccount
 * — "valueCents" absent leaves it untouched, "valueCents: null" clears it. */
export async function updateAsset(
  db: D1Database,
  householdId: string,
  id: string,
  input: { name?: string; type?: AssetType; valueCents?: number | null; notes?: string | null },
): Promise<Asset> {
  const existing = await getAsset(db, householdId, id);
  const name = input.name ?? existing.name;
  const type = input.type ?? existing.type;
  const valueCents = "valueCents" in input ? (input.valueCents ?? null) : existing.value_cents;
  const notes = "notes" in input ? (input.notes ?? null) : existing.notes;
  const now = nowIso();
  await db
    .prepare(`UPDATE asset SET name = ?, type = ?, value_cents = ?, notes = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(name, type, valueCents, notes, now, id, householdId)
    .run();
  return { ...existing, name, type, value_cents: valueCents, notes, updated_at: now };
}

/** Archive, never delete (PLAN.md §3, §9) — document and maintenance_task
 * rows reference an asset, including historical ones for a sold car or a
 * retired appliance. */
export async function archiveAsset(db: D1Database, householdId: string, id: string): Promise<Asset> {
  const now = nowIso();
  await db.prepare(`UPDATE asset SET archived_at = ?, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, now, id, householdId).run();
  return getAsset(db, householdId, id);
}

export async function unarchiveAsset(db: D1Database, householdId: string, id: string): Promise<Asset> {
  const now = nowIso();
  await db.prepare(`UPDATE asset SET archived_at = NULL, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, id, householdId).run();
  return getAsset(db, householdId, id);
}

export interface AssetWithCounts extends Asset {
  documentCount: number;
  openTaskCount: number;
}

/** One query, not one round trip per asset — the Assets/Summary page
 * renders every asset's document and open-task counts at once. */
export async function listAssetsWithCounts(db: D1Database, householdId: string): Promise<AssetWithCounts[]> {
  const { results } = await db
    .prepare(
      `SELECT a.*,
         (SELECT COUNT(*) FROM document d WHERE d.asset_id = a.id AND d.archived_at IS NULL) AS documentCount,
         (SELECT COUNT(*) FROM maintenance_task m WHERE m.asset_id = a.id AND m.completed_at IS NULL) AS openTaskCount
       FROM asset a
       WHERE a.household_id = ? AND a.archived_at IS NULL
       ORDER BY a.name`,
    )
    .bind(householdId)
    .all<AssetWithCounts>();
  return results;
}
