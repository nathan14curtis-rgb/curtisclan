import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../types";
import { getSessionByToken, SESSION_COOKIE } from "./session";

/** Gates every household-scoped route (PLAN.md §10). Requires a valid
 * session cookie whose household matches the ":householdId" route param —
 * a session for one household must never touch another's data, so this
 * checks identity, not just "logged in as someone." Mounted on both the
 * scoped router in src/index.ts and household-detail routes that sit
 * outside it (src/routes/households.ts). */
export const requireSession: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "not logged in" }, 401);

  const session = await getSessionByToken(c.env.DB, token);
  if (!session) return c.json({ error: "not logged in" }, 401);

  const householdId = c.req.param("householdId");
  if (householdId && session.household_id !== householdId) {
    return c.json({ error: "not logged in" }, 401);
  }

  await next();
};
