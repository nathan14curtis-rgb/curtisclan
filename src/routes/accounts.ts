import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { AccountType, Env } from "../types";
import { createAccount, listAccounts } from "../db/accounts";

const ACCOUNT_TYPES: AccountType[] = ["depository_checking", "depository_savings", "credit_card", "other"];

export const accountsRoute = new Hono<{ Bindings: Env }>();

accountsRoute.get("/", async (c) => {
  const accounts = await listAccounts(c.env.DB, requireParam(c, "householdId"));
  return c.json(accounts);
});

accountsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; type?: string; mask?: string; ownerUserId?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.type || !ACCOUNT_TYPES.includes(body.type as AccountType)) {
    return c.json({ error: `type must be one of ${ACCOUNT_TYPES.join(", ")}` }, 400);
  }
  const account = await createAccount(c.env.DB, requireParam(c, "householdId"), {
    name: body.name,
    type: body.type as AccountType,
    mask: body.mask,
    ownerUserId: body.ownerUserId,
  });
  return c.json(account, 201);
});
