import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createTag, deleteTag, listTags, updateTag } from "../db/tags";

export const tagsRoute = new Hono<{ Bindings: Env }>();

tagsRoute.get("/", async (c) => {
  return c.json(await listTags(c.env.DB, requireParam(c, "householdId")));
});

tagsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string | null }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  // Creating a tag that already exists returns the existing one rather
  // than 409ing — two people typing "vacation" should land on one tag.
  const tag = await createTag(c.env.DB, requireParam(c, "householdId"), { name: body.name, color: body.color });
  return c.json(tag, 201);
});

tagsRoute.patch("/:tagId", async (c) => {
  const body = await c.req.json<{ name?: string; color?: string | null }>();
  const tag = await updateTag(c.env.DB, requireParam(c, "householdId"), requireParam(c, "tagId"), body);
  return c.json(tag);
});

tagsRoute.delete("/:tagId", async (c) => {
  await deleteTag(c.env.DB, requireParam(c, "householdId"), requireParam(c, "tagId"));
  return c.json({ ok: true });
});
