import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Action, Condition } from "../categorization/rules";
import type { Env } from "../types";
import { createRule, listRules } from "../db/rules";

export const rulesRoute = new Hono<{ Bindings: Env }>();

rulesRoute.get("/", async (c) => {
  const rules = await listRules(c.env.DB, requireParam(c, "householdId"));
  return c.json(rules);
});

rulesRoute.post("/", async (c) => {
  const body = await c.req.json<{ priority?: number; conditions?: Condition; actions?: Action[] }>();
  if (!body.conditions) return c.json({ error: "conditions is required" }, 400);
  if (!body.actions || body.actions.length === 0) return c.json({ error: "actions must be a non-empty array" }, 400);

  const rule = await createRule(c.env.DB, requireParam(c, "householdId"), {
    priority: body.priority,
    conditions: body.conditions,
    actions: body.actions,
  });
  return c.json(rule, 201);
});
