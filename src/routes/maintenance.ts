import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { AssetType, Env } from "../types";
import {
  completeMaintenanceTask,
  createMaintenanceTask,
  getMaintenanceTask,
  listMaintenanceTasks,
  reopenMaintenanceTask,
  updateMaintenanceTask,
} from "../db/maintenance";

const ASSET_TYPES: AssetType[] = ["property", "vehicle", "appliance", "other"];

export const maintenanceRoute = new Hono<{ Bindings: Env }>();

maintenanceRoute.get("/", async (c) => {
  const assetType = c.req.query("assetType");
  if (assetType && !ASSET_TYPES.includes(assetType as AssetType)) {
    return c.json({ error: `assetType must be one of ${ASSET_TYPES.join(", ")}` }, 400);
  }
  const tasks = await listMaintenanceTasks(c.env.DB, requireParam(c, "householdId"), {
    assetType: assetType as AssetType | undefined,
    assetId: c.req.query("assetId"),
    includeCompleted: c.req.query("includeCompleted") === "true",
  });
  return c.json(tasks);
});

maintenanceRoute.get("/:taskId", async (c) => {
  const task = await getMaintenanceTask(c.env.DB, requireParam(c, "householdId"), requireParam(c, "taskId"));
  return c.json(task);
});

maintenanceRoute.post("/", async (c) => {
  const body = await c.req.json<{ assetId?: string; task?: string; dueDate?: string; notes?: string }>();
  if (!body.assetId) return c.json({ error: "assetId is required" }, 400);
  if (!body.task) return c.json({ error: "task is required" }, 400);
  if (!body.dueDate) return c.json({ error: "dueDate is required" }, 400);
  const task = await createMaintenanceTask(c.env.DB, requireParam(c, "householdId"), {
    assetId: body.assetId,
    task: body.task,
    dueDate: body.dueDate,
    notes: body.notes,
  });
  return c.json(task, 201);
});

maintenanceRoute.patch("/:taskId", async (c) => {
  const body = await c.req.json<{ task?: string; dueDate?: string; notes?: string | null }>();
  const update: { task?: string; dueDate?: string; notes?: string | null } = {};
  if (body.task !== undefined) update.task = body.task;
  if (body.dueDate !== undefined) update.dueDate = body.dueDate;
  if ("notes" in body) update.notes = body.notes;

  const task = await updateMaintenanceTask(c.env.DB, requireParam(c, "householdId"), requireParam(c, "taskId"), update);
  return c.json(task);
});

maintenanceRoute.post("/:taskId/complete", async (c) => {
  const task = await completeMaintenanceTask(c.env.DB, requireParam(c, "householdId"), requireParam(c, "taskId"));
  return c.json(task);
});

maintenanceRoute.post("/:taskId/reopen", async (c) => {
  const task = await reopenMaintenanceTask(c.env.DB, requireParam(c, "householdId"), requireParam(c, "taskId"));
  return c.json(task);
});
