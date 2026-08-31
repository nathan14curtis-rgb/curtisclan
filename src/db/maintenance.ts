import { newId } from "../lib/id";
import type { AssetType, MaintenanceTask } from "../types";
import { getScoped, nowIso } from "./client";

export type MaintenanceStatus = "scheduled" | "due_soon" | "overdue" | "done";

const DUE_SOON_WINDOW_DAYS = 14;
const MS_PER_DAY = 86_400_000;

/** Pure, DB-free — same style as src/envelopes/ledger.ts's pure functions,
 * so the 14-day window is one named constant and this is unit-testable
 * without D1. Status is derived at read time, never stored (PLAN.md §3's
 * "derive, don't store" rule for envelope balances applies just as well
 * here: due_date and completed_at are the only facts, everything else is
 * a computation over them). */
export function deriveMaintenanceStatus(dueDate: string, completedAt: string | null, referenceDate = nowIso().slice(0, 10)): MaintenanceStatus {
  if (completedAt) return "done";
  const daysUntilDue = (Date.parse(dueDate) - Date.parse(referenceDate)) / MS_PER_DAY;
  if (daysUntilDue < 0) return "overdue";
  if (daysUntilDue <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "scheduled";
}

export interface MaintenanceTaskWithStatus extends MaintenanceTask {
  status: MaintenanceStatus;
}

export interface ListMaintenanceTasksFilter {
  assetType?: AssetType;
  assetId?: string;
  includeCompleted?: boolean;
}

/** assetType filters via a join against asset — this is the real
 * implementation of the Maintenance page's House/Car split: tasks aren't
 * tagged with a free-text "House"/"Car" label, they belong to a specific
 * asset instance, and the nav leaf groups by that asset's type. */
export async function listMaintenanceTasks(
  db: D1Database,
  householdId: string,
  filter: ListMaintenanceTasksFilter = {},
): Promise<MaintenanceTaskWithStatus[]> {
  const clauses = ["m.household_id = ?"];
  const params: unknown[] = [householdId];
  if (filter.assetType) {
    clauses.push("a.type = ?");
    params.push(filter.assetType);
  }
  if (filter.assetId) {
    clauses.push("m.asset_id = ?");
    params.push(filter.assetId);
  }
  if (!filter.includeCompleted) {
    clauses.push("m.completed_at IS NULL");
  }
  const { results } = await db
    .prepare(
      `SELECT m.* FROM maintenance_task m JOIN asset a ON a.id = m.asset_id
       WHERE ${clauses.join(" AND ")} ORDER BY m.due_date`,
    )
    .bind(...params)
    .all<MaintenanceTask>();
  return results.map((row) => ({ ...row, status: deriveMaintenanceStatus(row.due_date, row.completed_at) }));
}

export async function getMaintenanceTask(db: D1Database, householdId: string, id: string): Promise<MaintenanceTaskWithStatus> {
  const task = await getScoped<MaintenanceTask>(db, "maintenance_task", householdId, id);
  return { ...task, status: deriveMaintenanceStatus(task.due_date, task.completed_at) };
}

export async function createMaintenanceTask(
  db: D1Database,
  householdId: string,
  input: { assetId: string; task: string; dueDate: string; notes?: string | null },
): Promise<MaintenanceTask> {
  const id = newId("mnt");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO maintenance_task (id, household_id, asset_id, task, due_date, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.assetId, input.task, input.dueDate, input.notes ?? null, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    asset_id: input.assetId,
    task: input.task,
    due_date: input.dueDate,
    completed_at: null,
    notes: input.notes ?? null,
    created_at: now,
    updated_at: now,
  };
}

export async function updateMaintenanceTask(
  db: D1Database,
  householdId: string,
  id: string,
  input: { task?: string; dueDate?: string; notes?: string | null },
): Promise<MaintenanceTask> {
  const existing = await getScoped<MaintenanceTask>(db, "maintenance_task", householdId, id);
  const task = input.task ?? existing.task;
  const dueDate = input.dueDate ?? existing.due_date;
  const notes = "notes" in input ? (input.notes ?? null) : existing.notes;
  const now = nowIso();
  await db
    .prepare(`UPDATE maintenance_task SET task = ?, due_date = ?, notes = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(task, dueDate, notes, now, id, householdId)
    .run();
  return { ...existing, task, due_date: dueDate, notes, updated_at: now };
}

export async function completeMaintenanceTask(db: D1Database, householdId: string, id: string): Promise<MaintenanceTask> {
  const now = nowIso();
  await db
    .prepare(`UPDATE maintenance_task SET completed_at = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(now, now, id, householdId)
    .run();
  return getScoped<MaintenanceTask>(db, "maintenance_task", householdId, id);
}

export async function reopenMaintenanceTask(db: D1Database, householdId: string, id: string): Promise<MaintenanceTask> {
  const now = nowIso();
  await db
    .prepare(`UPDATE maintenance_task SET completed_at = NULL, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(now, id, householdId)
    .run();
  return getScoped<MaintenanceTask>(db, "maintenance_task", householdId, id);
}
