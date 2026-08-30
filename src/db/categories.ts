import { newId } from "../lib/id";
import { DEFAULT_CATEGORIES } from "../lib/defaultCategories";
import type { Category, CategoryKind, Envelope } from "../types";
import { getScoped, listScoped, nowIso } from "./client";

export async function listCategories(db: D1Database, householdId: string): Promise<Category[]> {
  return listScoped<Category>(db, "category", householdId, "sort_order, name");
}

export async function getCategory(db: D1Database, householdId: string, id: string): Promise<Category> {
  return getScoped<Category>(db, "category", householdId, id);
}

export async function createCategory(
  db: D1Database,
  householdId: string,
  input: { name: string; kind: CategoryKind; parentId?: string | null; sortOrder?: number },
): Promise<Category> {
  const id = newId("cat");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO category (id, household_id, parent_id, name, kind, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.parentId ?? null, input.name, input.kind, input.sortOrder ?? 0, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    parent_id: input.parentId ?? null,
    name: input.name,
    kind: input.kind,
    sort_order: input.sortOrder ?? 0,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Every expense/savings category is also an envelope (PLAN.md §3: "One
 * concept, less code"). Income and transfer categories are never funded. */
export async function createEnvelopeForCategory(
  db: D1Database,
  householdId: string,
  category: Category,
  opts: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null } = {},
): Promise<Envelope> {
  if (category.kind !== "expense" && category.kind !== "savings") {
    throw new Error(`category kind '${category.kind}' is not funded and has no envelope`);
  }
  const id = newId("env");
  const now = nowIso();
  const groupName = opts.groupName ?? "Uncategorized";
  await db
    .prepare(
      `INSERT INTO envelope (id, household_id, category_id, group_name, sort_order, monthly_target_cents, target_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      householdId,
      category.id,
      groupName,
      0,
      opts.monthlyTargetCents ?? null,
      opts.targetDate ?? null,
      now,
      now,
    )
    .run();
  return {
    id,
    household_id: householdId,
    category_id: category.id,
    group_name: groupName,
    sort_order: 0,
    monthly_target_cents: opts.monthlyTargetCents ?? null,
    target_date: opts.targetDate ?? null,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function seedDefaultCategories(db: D1Database, householdId: string): Promise<void> {
  let sortOrder = 0;
  for (const def of DEFAULT_CATEGORIES) {
    const category = await createCategory(db, householdId, {
      name: def.name,
      kind: def.kind,
      sortOrder: sortOrder++,
    });
    if (def.kind === "expense" || def.kind === "savings") {
      await createEnvelopeForCategory(db, householdId, category, {
        groupName: def.group,
        monthlyTargetCents: def.monthlyTargetCents ?? null,
      });
    }
  }
}
