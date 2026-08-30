import { Hono } from "hono";
import { requireSecret } from "../lib/secrets";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { createInboundMessage, findInboundMessageByHandle } from "../db/inboundMessages";
import { findUserByVerifiedPhone } from "../db/users";
import type { InboundWebhookPayload } from "../sendblue/types";

export const sendblueWebhookRoute = new Hono<{ Bindings: Env }>();

/**
 * Sendblue signs webhook requests with a shared `sb-signing-secret`
 * header (PLAN.md §10). Dedupes on message_handle (§5.1: "Sendblue can
 * redeliver, and a redelivered reply must not double-apply") and never
 * resolves a household/user from an unverified from_number (§10: "Never
 * let an inbound text disclose data before the number is bound to a
 * verified user").
 */
sendblueWebhookRoute.post("/", async (c) => {
  const signingSecret = requireSecret(c.env, "SENDBLUE_SIGNING_SECRET");
  const providedSecret = c.req.header("sb-signing-secret");
  if (!providedSecret || !timingSafeEqual(providedSecret, signingSecret)) {
    return c.json({ error: "invalid signing secret" }, 401);
  }

  const payload = await c.req.json<InboundWebhookPayload>();
  if (payload.is_outbound) return c.json({ ok: true }); // our own send's status callback, not a reply

  const fromNumber = payload.from_number ?? payload.number;
  if (!fromNumber || !payload.message_handle) return c.json({ ok: true });

  const existing = await findInboundMessageByHandle(c.env.DB, payload.message_handle);
  if (existing) return c.json({ ok: true }); // redelivery — already recorded (and possibly already processed)

  const user = await findUserByVerifiedPhone(c.env.DB, fromNumber);

  const inboundMessage = await createInboundMessage(c.env.DB, {
    householdId: user?.household_id ?? null,
    userId: user?.id ?? null,
    fromNumber,
    messageHandle: payload.message_handle,
    content: payload.content,
    receivedAt: payload.date_sent ?? new Date().toISOString(),
    rawPayload: payload,
  });

  if (user) {
    const message: TransactionQueueMessage = {
      type: "resolve_reply",
      householdId: user.household_id,
      userId: user.id,
      inboundMessageId: inboundMessage.id,
    };
    await c.env.TRANSACTION_QUEUE.send(message);
  }

  return c.json({ ok: true });
});
