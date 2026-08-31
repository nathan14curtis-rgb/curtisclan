import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { AssetType, Env } from "../types";
import { archiveAsset, createAsset, getAsset, listAssetsWithCounts, unarchiveAsset, updateAsset } from "../db/assets";

const ASSET_TYPES: AssetType[] = ["property", "vehicle", "appliance", "other"];

export const assetsRoute = new Hono<{ Bindings: Env }>();

assetsRoute.get("/", async (c) => {
  const assets = await listAssetsWithCounts(c.env.DB, requireParam(c, "householdId"));
  return c.json(assets);
});

assetsRoute.get("/:assetId", async (c) => {
  const asset = await getAsset(c.env.DB, requireParam(c, "householdId"), requireParam(c, "assetId"));
  return c.json(asset);
});

assetsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; type?: string; valueCents?: number; notes?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.type || !ASSET_TYPES.includes(body.type as AssetType)) {
    return c.json({ error: `type must be one of ${ASSET_TYPES.join(", ")}` }, 400);
  }
  const asset = await createAsset(c.env.DB, requireParam(c, "householdId"), {
    name: body.name,
    type: body.type as AssetType,
    valueCents: body.valueCents,
    notes: body.notes,
  });
  return c.json(asset, 201);
});

assetsRoute.patch("/:assetId", async (c) => {
  const body = await c.req.json<{ name?: string; type?: string; valueCents?: number | null; notes?: string | null }>();
  if (body.type && !ASSET_TYPES.includes(body.type as AssetType)) {
    return c.json({ error: `type must be one of ${ASSET_TYPES.join(", ")}` }, 400);
  }
  // Same "omitted vs. explicit null" reconstruction as accounts.ts's PATCH
  // handler — updateAsset tells the two apart via `"valueCents" in input`.
  const update: { name?: string; type?: AssetType; valueCents?: number | null; notes?: string | null } = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.type !== undefined) update.type = body.type as AssetType;
  if ("valueCents" in body) update.valueCents = body.valueCents;
  if ("notes" in body) update.notes = body.notes;

  const asset = await updateAsset(c.env.DB, requireParam(c, "householdId"), requireParam(c, "assetId"), update);
  return c.json(asset);
});

assetsRoute.post("/:assetId/archive", async (c) => {
  const asset = await archiveAsset(c.env.DB, requireParam(c, "householdId"), requireParam(c, "assetId"));
  return c.json(asset);
});

assetsRoute.post("/:assetId/unarchive", async (c) => {
  const asset = await unarchiveAsset(c.env.DB, requireParam(c, "householdId"), requireParam(c, "assetId"));
  return c.json(asset);
});
