import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createUser, listUsers, verifyUserPhone } from "../db/users";

export const usersRoute = new Hono<{ Bindings: Env }>();

usersRoute.get("/", async (c) => {
  const users = await listUsers(c.env.DB, requireParam(c, "householdId"));
  return c.json(users);
});

usersRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; timezone?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const user = await createUser(c.env.DB, requireParam(c, "householdId"), { name: body.name, timezone: body.timezone });
  return c.json(user, 201);
});

// The Sendblue verification handshake (PLAN §5.0) completes out-of-band;
// this endpoint records the binding once it has, per §10: from_number is
// the only thing authenticating an inbound reply, so it must never be
// set without an out-of-band verification step.
usersRoute.post("/:userId/verify-phone", async (c) => {
  const body = await c.req.json<{ phoneE164?: string }>();
  if (!body.phoneE164 || !/^\+\d{8,15}$/.test(body.phoneE164)) {
    return c.json({ error: "phoneE164 must be E.164, e.g. +13035551234" }, 400);
  }
  const user = await verifyUserPhone(c.env.DB, requireParam(c, "householdId"), requireParam(c, "userId"), body.phoneE164);
  return c.json(user);
});
