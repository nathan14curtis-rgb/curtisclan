import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createHousehold, getHousehold } from "../db/households";
import { createUser } from "../db/users";
import { createSession, sessionCookieOptions, SESSION_COOKIE } from "../lib/session";
import { requireSession } from "../lib/authMiddleware";

export const householdsRoute = new Hono<{ Bindings: Env }>();

// The sign-up entry point (PLAN.md §10) — the only household-creating
// write that's reachable with no session, since there's nothing to
// protect yet. Creates the household's first member and logs the creator
// straight in; verifying a real phone number (for OTP login on another
// device later) happens afterward, from inside this session, via
// POST /:householdId/users/:userId/verify-phone.
householdsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; timezone?: string; creatorName?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.creatorName) return c.json({ error: "creatorName is required" }, 400);

  const household = await createHousehold(c.env.DB, { name: body.name, timezone: body.timezone });
  const user = await createUser(c.env.DB, household.id, { name: body.creatorName });
  const { token } = await createSession(c.env.DB, { householdId: household.id, userId: user.id });
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.env));

  return c.json({ household, userId: user.id }, 201);
});

householdsRoute.get("/:householdId", requireSession, async (c) => {
  const household = await getHousehold(c.env.DB, requireParam(c, "householdId"));
  return c.json(household);
});
