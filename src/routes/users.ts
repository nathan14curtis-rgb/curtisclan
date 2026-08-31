import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { AccessLevel, Env } from "../types";
import { createUser, listUsers, updateUser, verifyUserPhone } from "../db/users";

const ACCESS_LEVELS: AccessLevel[] = ["full", "limited", "view_only"];

export const usersRoute = new Hono<{ Bindings: Env }>();

usersRoute.get("/", async (c) => {
  const users = await listUsers(c.env.DB, requireParam(c, "householdId"));
  return c.json(users);
});

usersRoute.post("/", async (c) => {
  const body = await c.req.json<{
    name?: string;
    timezone?: string;
    role?: string;
    accessLevel?: string;
    weeklyAllowanceCents?: number;
    note?: string;
  }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (body.accessLevel && !ACCESS_LEVELS.includes(body.accessLevel as AccessLevel)) {
    return c.json({ error: `accessLevel must be one of ${ACCESS_LEVELS.join(", ")}` }, 400);
  }
  const user = await createUser(c.env.DB, requireParam(c, "householdId"), {
    name: body.name,
    timezone: body.timezone,
    role: body.role,
    accessLevel: body.accessLevel as AccessLevel | undefined,
    weeklyAllowanceCents: body.weeklyAllowanceCents,
    note: body.note,
  });
  return c.json(user, 201);
});

// Member profile edit — the redesigned Members page's card fields.
usersRoute.patch("/:userId", async (c) => {
  const body = await c.req.json<{
    name?: string;
    timezone?: string;
    role?: string | null;
    accessLevel?: string;
    weeklyAllowanceCents?: number | null;
    note?: string | null;
  }>();
  if (body.accessLevel && !ACCESS_LEVELS.includes(body.accessLevel as AccessLevel)) {
    return c.json({ error: `accessLevel must be one of ${ACCESS_LEVELS.join(", ")}` }, 400);
  }
  const update: {
    name?: string;
    timezone?: string;
    role?: string | null;
    accessLevel?: AccessLevel;
    weeklyAllowanceCents?: number | null;
    note?: string | null;
  } = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.timezone !== undefined) update.timezone = body.timezone;
  if ("role" in body) update.role = body.role;
  if (body.accessLevel !== undefined) update.accessLevel = body.accessLevel as AccessLevel;
  if ("weeklyAllowanceCents" in body) update.weeklyAllowanceCents = body.weeklyAllowanceCents;
  if ("note" in body) update.note = body.note;

  const user = await updateUser(c.env.DB, requireParam(c, "householdId"), requireParam(c, "userId"), update);
  return c.json(user);
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
