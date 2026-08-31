import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { archiveAsset, createAsset, getAsset, listAssetsWithCounts, unarchiveAsset, updateAsset } from "../src/db/assets";
import { archiveDocument, createDocument, listDocuments, updateDocument } from "../src/db/documents";
import { completeMaintenanceTask, createMaintenanceTask, listMaintenanceTasks, reopenMaintenanceTask, updateMaintenanceTask } from "../src/db/maintenance";
import { NotFoundError } from "../src/db/client";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  return { household, nathan };
}

describe("asset CRUD", () => {
  it("creates, updates (respecting omitted-vs-null), and archives/unarchives an asset", async () => {
    const { household } = await seedHousehold();
    const asset = await createAsset(db, household.id, { name: "Honda CR-V 2021", type: "vehicle", valueCents: 2140000 });
    expect(asset.value_cents).toBe(2140000);

    const renamed = await updateAsset(db, household.id, asset.id, { name: "Honda CR-V" });
    expect(renamed.name).toBe("Honda CR-V");
    expect(renamed.value_cents).toBe(2140000); // untouched — key omitted

    const cleared = await updateAsset(db, household.id, asset.id, { valueCents: null });
    expect(cleared.value_cents).toBeNull();

    const archived = await archiveAsset(db, household.id, asset.id);
    expect(archived.archived_at).not.toBeNull();
    expect(await listAssetsWithCounts(db, household.id)).toHaveLength(0);

    const restored = await unarchiveAsset(db, household.id, asset.id);
    expect(restored.archived_at).toBeNull();
    expect(await listAssetsWithCounts(db, household.id)).toHaveLength(1);
  });

  it("404s reading an asset scoped to a different household", async () => {
    const { household } = await seedHousehold();
    const other = await createHousehold(db, { name: "Someone Else" });
    const asset = await createAsset(db, household.id, { name: "Home", type: "property" });
    await expect(getAsset(db, other.id, asset.id)).rejects.toThrow(NotFoundError);
  });
});

describe("listAssetsWithCounts", () => {
  it("counts documents and open maintenance tasks per asset, unevenly", async () => {
    const { household } = await seedHousehold();
    const car = await createAsset(db, household.id, { name: "Honda CR-V", type: "vehicle" });
    const house = await createAsset(db, household.id, { name: "Home", type: "property" });

    await createDocument(db, household.id, { name: "Auto insurance", category: "insurance", assetId: car.id });
    await createDocument(db, household.id, { name: "Registration", category: "identification", assetId: car.id });
    await createDocument(db, household.id, { name: "Homeowners policy", category: "insurance", assetId: house.id });

    const openTask = await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Tire rotation", dueDate: "2026-09-20" });
    await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Oil change", dueDate: "2026-06-01" });
    await completeMaintenanceTask(db, household.id, openTask.id);
    // Completing the first task above leaves this one, plus a second still-open one, as the only open task.
    await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Brake check", dueDate: "2026-10-01" });

    const counts = await listAssetsWithCounts(db, household.id);
    const carCounts = counts.find((a) => a.id === car.id)!;
    const houseCounts = counts.find((a) => a.id === house.id)!;
    expect(carCounts.documentCount).toBe(2);
    expect(carCounts.openTaskCount).toBe(2); // oil change + brake check; tire rotation was completed
    expect(houseCounts.documentCount).toBe(1);
    expect(houseCounts.openTaskCount).toBe(0);
  });
});

describe("document CRUD", () => {
  it("filters by category, matching the Insurance/Warranties/Identification/Passwords nav leaves", async () => {
    const { household, nathan } = await seedHousehold();
    await createDocument(db, household.id, { name: "Homeowners policy", category: "insurance", ownerUserId: nathan.id });
    await createDocument(db, household.id, { name: "Wi-Fi credentials", category: "passwords" });

    expect(await listDocuments(db, household.id, { category: "insurance" })).toHaveLength(1);
    expect(await listDocuments(db, household.id, { category: "passwords" })).toHaveLength(1);
    expect(await listDocuments(db, household.id)).toHaveLength(2);
  });

  it("updates detail/owner (respecting omitted-vs-null) and archives without deleting", async () => {
    const { household, nathan } = await seedHousehold();
    const doc = await createDocument(db, household.id, { name: "Refrigerator warranty", category: "warranty" });

    const updated = await updateDocument(db, household.id, doc.id, { detail: "Expires Mar 2028", ownerUserId: nathan.id });
    expect(updated.detail).toBe("Expires Mar 2028");
    expect(updated.owner_user_id).toBe(nathan.id);

    const renamedOnly = await updateDocument(db, household.id, doc.id, { name: "Fridge warranty" });
    expect(renamedOnly.detail).toBe("Expires Mar 2028"); // untouched — key omitted

    const archived = await archiveDocument(db, household.id, doc.id);
    expect(archived.archived_at).not.toBeNull();
    expect(await listDocuments(db, household.id)).toHaveLength(0);
  });
});

describe("maintenance task CRUD and the House/Car asset-type join", () => {
  it("filters by asset type via the join, not a free-text label on the task", async () => {
    const { household } = await seedHousehold();
    const car = await createAsset(db, household.id, { name: "Subaru Outback", type: "vehicle" });
    const house = await createAsset(db, household.id, { name: "Home", type: "property" });
    await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Oil change", dueDate: "2026-06-01" });
    await createMaintenanceTask(db, household.id, { assetId: house.id, task: "Gutter cleaning", dueDate: "2026-09-06" });

    const carTasks = await listMaintenanceTasks(db, household.id, { assetType: "vehicle" });
    const houseTasks = await listMaintenanceTasks(db, household.id, { assetType: "property" });
    expect(carTasks.map((t) => t.task)).toEqual(["Oil change"]);
    expect(houseTasks.map((t) => t.task)).toEqual(["Gutter cleaning"]);
  });

  it("excludes completed tasks by default, includes them with includeCompleted, and each carries a derived status", async () => {
    const { household } = await seedHousehold();
    const car = await createAsset(db, household.id, { name: "Honda CR-V", type: "vehicle" });
    const task = await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Oil change", dueDate: "2099-06-01" });

    expect((await listMaintenanceTasks(db, household.id, { assetId: car.id }))[0]!.status).toBe("scheduled");

    await completeMaintenanceTask(db, household.id, task.id);
    expect(await listMaintenanceTasks(db, household.id, { assetId: car.id })).toHaveLength(0);
    const withCompleted = await listMaintenanceTasks(db, household.id, { assetId: car.id, includeCompleted: true });
    expect(withCompleted).toHaveLength(1);
    expect(withCompleted[0]!.status).toBe("done");

    const reopened = await reopenMaintenanceTask(db, household.id, task.id);
    expect(reopened.completed_at).toBeNull();
    expect(await listMaintenanceTasks(db, household.id, { assetId: car.id })).toHaveLength(1);
  });

  it("updates task/dueDate/notes respecting the omitted-vs-null convention", async () => {
    const { household } = await seedHousehold();
    const car = await createAsset(db, household.id, { name: "Honda CR-V", type: "vehicle" });
    const task = await createMaintenanceTask(db, household.id, { assetId: car.id, task: "Oil change", dueDate: "2026-06-01", notes: "synthetic" });

    const rescheduled = await updateMaintenanceTask(db, household.id, task.id, { dueDate: "2026-06-15" });
    expect(rescheduled.due_date).toBe("2026-06-15");
    expect(rescheduled.notes).toBe("synthetic"); // untouched — key omitted

    const clearedNotes = await updateMaintenanceTask(db, household.id, task.id, { notes: null });
    expect(clearedNotes.notes).toBeNull();
  });
});
