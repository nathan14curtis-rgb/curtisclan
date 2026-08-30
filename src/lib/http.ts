import type { Context } from "hono";

/** Hono types c.req.param(name) as `string | undefined` because it can't
 * statically see the parent router's path pattern from a mounted sub-app.
 * Every call site here is for a segment the parent route always supplies
 * (e.g. ":householdId" on a router mounted at "/:householdId/users") —
 * this documents that invariant in one place instead of an `!` at each
 * call site. */
export function requireParam(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`missing required route param: ${name}`);
  return value;
}
