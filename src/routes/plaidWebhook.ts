import { Hono } from "hono";
import { requireParam } from "../lib/http";
import { getPlaidConfig } from "../lib/secrets";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { getPlaidItemByPlaidId } from "../db/plaidItems";
import { verifyPlaidWebhook, WebhookVerificationError } from "../plaid/webhookAuth";

export const plaidWebhookRoute = new Hono<{ Bindings: Env }>();

interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
}

/**
 * "Webhook Worker does exactly three things: verify signature, enqueue,
 * return 200. Plaid retries on timeout — do real work in the request and
 * you will double-process." (PLAN.md §4.2) The plaid_item lookup below is
 * a single indexed read to route the job, not the sync itself — the
 * actual sync/item-status work happens in the queue consumer.
 */
plaidWebhookRoute.post("/:householdId", async (c) => {
  const householdId = requireParam(c, "householdId");
  const rawBody = await c.req.text();

  try {
    await verifyPlaidWebhook(c.env.DB, getPlaidConfig(c.env), c.req.header("plaid-verification") ?? null, rawBody);
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      console.error("Plaid webhook verification failed:", err.message);
      return c.json({ error: "invalid webhook signature" }, 401);
    }
    throw err;
  }

  const payload = JSON.parse(rawBody) as PlaidWebhookPayload;
  const item = await getPlaidItemByPlaidId(c.env.DB, payload.item_id);
  if (!item || item.household_id !== householdId) {
    // Unrecognized item for this household — ack with 200 anyway so Plaid
    // doesn't retry; there's nothing to enqueue.
    return c.json({ ok: true });
  }

  let message: TransactionQueueMessage | null = null;
  if (payload.webhook_type === "TRANSACTIONS") {
    message = { type: "plaid_sync", householdId, plaidItemId: payload.item_id };
  } else if (payload.webhook_type === "ITEM") {
    message = { type: "item_webhook", householdId, plaidItemId: payload.item_id, webhookCode: payload.webhook_code };
  }

  if (message) await c.env.TRANSACTION_QUEUE.send(message);
  return c.json({ ok: true });
});
