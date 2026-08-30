import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createHousehold, getHousehold } from "../db/households";

export const householdsRoute = new Hono<{ Bindings: Env }>();

householdsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; timezone?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const household = await createHousehold(c.env.DB, { name: body.name, timezone: body.timezone });
  return c.json(household, 201);
});

householdsRoute.get("/:householdId", async (c) => {
  const household = await getHousehold(c.env.DB, requireParam(c, "householdId"));
  return c.json(household);
});
