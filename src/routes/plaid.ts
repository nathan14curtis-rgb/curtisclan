import { Hono } from "hono";
import { requireParam } from "../lib/http";
import { getEncryptionKey, getPlaidConfig } from "../lib/secrets";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { createLinkToken, exchangePublicToken } from "../plaid/client";
import { createPlaidItem } from "../db/plaidItems";

export const plaidRoute = new Hono<{ Bindings: Env }>();

/** The dashboard's Plaid Link web SDK calls this to start a Link session
 * (PLAN.md §4.1). The webhook URL is scoped to this household so the
 * webhook handler always knows which household an inbound event belongs
 * to without a lookup-only guess. */
plaidRoute.post("/link-token", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ userId?: string }>();
  if (!body.userId) return c.json({ error: "userId is required" }, 400);

  const webhookUrl = `${new URL(c.req.url).origin}/webhooks/plaid/${householdId}`;
  const result = await createLinkToken(getPlaidConfig(c.env), { clientUserId: body.userId, webhookUrl });
  return c.json(result);
});

/**
 * Exchanges Link's public_token for a permanent access_token — must
 * happen server-side; the access_token must never reach the browser
 * (PLAN.md §4.1). Kicks an immediate sync rather than waiting on Plaid's
 * first webhook, per Plaid's own guidance for a newly linked item.
 */
plaidRoute.post("/exchange-token", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ publicToken?: string; institutionName?: string }>();
  if (!body.publicToken) return c.json({ error: "publicToken is required" }, 400);

  const plaidConfig = getPlaidConfig(c.env);
  const encryptionKey = await getEncryptionKey(c.env);
  const { access_token, item_id } = await exchangePublicToken(plaidConfig, body.publicToken);

  await createPlaidItem(
    c.env.DB,
    householdId,
    { plaidItemId: item_id, accessToken: access_token, institutionName: body.institutionName },
    encryptionKey,
  );

  const message: TransactionQueueMessage = { type: "plaid_sync", householdId, plaidItemId: item_id };
  await c.env.TRANSACTION_QUEUE.send(message);

  return c.json({ itemId: item_id }, 201);
});
