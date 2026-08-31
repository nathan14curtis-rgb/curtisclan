import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { AccountStatus, AccountType, Env } from "../types";
import { createAccount, listAccounts, updateAccount } from "../db/accounts";
import { AccountNotPlaidLinkedError, unlinkPlaidAccount } from "../plaid/unlink";

const ACCOUNT_TYPES: AccountType[] = ["depository_checking", "depository_savings", "credit_card", "other"];
const ACCOUNT_STATUSES: AccountStatus[] = ["active", "login_required", "removed"];

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

// Rename, reassign the owning household member (or clear it, for a joint
// account), or set status — e.g. 'removed' once a card is closed. Plaid
// re-link status ('login_required' → 'active') is set by the sync
// pipeline itself, not this endpoint.
accountsRoute.patch("/:accountId", async (c) => {
  const body = await c.req.json<{ name?: string; ownerUserId?: string | null; status?: string }>();
  if (body.status && !ACCOUNT_STATUSES.includes(body.status as AccountStatus)) {
    return c.json({ error: `status must be one of ${ACCOUNT_STATUSES.join(", ")}` }, 400);
  }
  // Build the update from `body` directly rather than a fresh object
  // literal — updateAccount tells "omitted" from "explicitly null" via
  // `"ownerUserId" in input`, and reconstructing `{ ownerUserId: body.ownerUserId }`
  // would set that key (to undefined) even when the client never sent it.
  const update: { name?: string; ownerUserId?: string | null; status?: AccountStatus } = {};
  if (body.name !== undefined) update.name = body.name;
  if ("ownerUserId" in body) update.ownerUserId = body.ownerUserId;
  if (body.status !== undefined) update.status = body.status as AccountStatus;

  const account = await updateAccount(c.env.DB, requireParam(c, "householdId"), requireParam(c, "accountId"), update);
  return c.json(account);
});

// Plaid-specific removal: tells Plaid to release the Item (best-effort —
// a stale/cross-environment access token, e.g. leftover Sandbox test
// data now that PLAID_ENV is production, will never authenticate, and
// that's fine, not a reason to block), marks the item and account
// removed, and — only if asked — purges every transaction it synced.
// Manual/CSV-only accounts use the plain PATCH status='removed' above
// instead; they were never linked to anything to release.
accountsRoute.post("/:accountId/unlink", async (c) => {
  const body = await c.req.json<{ deleteTransactions?: boolean }>();
  try {
    const result = await unlinkPlaidAccount(c.env, requireParam(c, "householdId"), requireParam(c, "accountId"), {
      deleteTransactions: body.deleteTransactions === true,
    });
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof AccountNotPlaidLinkedError) return c.json({ error: err.message }, 400);
    throw err;
  }
});
