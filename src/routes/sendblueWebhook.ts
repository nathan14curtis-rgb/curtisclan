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
    console.error("[sendblueWebhook] rejected: missing or invalid sb-signing-secret header");
    return c.json({ error: "invalid signing secret" }, 401);
  }

  const payload = await c.req.json<InboundWebhookPayload>();
  if (payload.is_outbound) return c.json({ ok: true }); // our own send's status callback, not a reply

  const fromNumber = normalizePhone(payload.from_number ?? payload.number);
  if (!fromNumber || !payload.message_handle) {
    console.error(`[sendblueWebhook] dropped: missing from_number/number or message_handle (handle=${payload.message_handle ?? "none"})`);
    return c.json({ ok: true });
  }

  const existing = await findInboundMessageByHandle(c.env.DB, payload.message_handle);
  if (existing) {
    console.log(`[sendblueWebhook] redelivery of ${payload.message_handle} — already recorded, skipping`);
    return c.json({ ok: true });
  }

  const user = await findUserByVerifiedPhone(c.env.DB, fromNumber);
  if (!user) {
    // The one silent-drop this route used to have: a reply from a number
    // that doesn't exact-match any verified user.phone_e164 just vanished,
    // with no signal anywhere that it was ever received. Log it loudly —
    // this is the first thing to check when "I replied and nothing
    // happened" comes up, since a Sendblue group-reply payload's
    // from_number formatting is not guaranteed to match what was stored at
    // verification time.
    console.error(`[sendblueWebhook] no verified user for from_number=${fromNumber} (handle=${payload.message_handle}) — message recorded but not queued for processing`);
  }

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
    console.log(`[sendblueWebhook] queued resolve_reply for household ${user.household_id} (handle=${payload.message_handle})`);
  }

  return c.json({ ok: true });
});

/** Sendblue's from_number is documented as E.164, but a group-reply payload
 * has been seen with incidental formatting differences (surrounding
 * whitespace, a bare 10-digit US number missing the +1). Strip everything
 * but digits and a leading +, and add +1 to a bare 10-digit number, so an
 * exact-match lookup against the E.164 string stored at verification time
 * (src/db/users.ts findUserByVerifiedPhone) isn't broken by formatting
 * alone — this was silently dropping real replies with zero log signal. */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length > 0 ? `+${digits}` : null;
}
