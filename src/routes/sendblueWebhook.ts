import { Hono } from "hono";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import { describeError } from "../lib/errors";
import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { createInboundMessage, findInboundMessageByHandle } from "../db/inboundMessages";
import { findUserByVerifiedPhone, findUserByVerifiedPhoneSuffix } from "../db/users";
import type { InboundWebhookPayload } from "../sendblue/types";

export const sendblueWebhookRoute = new Hono<{ Bindings: Env }>();

/**
 * Sendblue signs webhook requests with a shared `sb-signing-secret`
 * header (PLAN.md §10). Dedupes on message_handle (§5.1: "Sendblue can
 * redeliver, and a redelivered reply must not double-apply") and never
 * resolves a household/user from an unverified from_number (§10: "Never
 * let an inbound text disclose data before the number is bound to a
 * verified user").
 *
 * Every rejection and drop below logs a single `[sendblueWebhook]` line
 * naming the reason. This route is the one place where a misconfiguration
 * (unset secret, a Sendblue webhook pointed at the wrong URL, a phone
 * number that never got verified) presents identically to the person
 * texting in — their message simply does nothing — so the log line is the
 * only way to tell those cases apart after the fact. Pair it with
 * GET /api/households/:householdId/messaging/diagnostics, which reports
 * the same conditions from stored state.
 */
sendblueWebhookRoute.post("/", async (c) => {
  const signingSecret = c.env.SENDBLUE_SIGNING_SECRET;
  if (!signingSecret) {
    // Previously this threw out of requireSecret into the generic 500
    // handler, which logs the error object but reads like an app crash
    // rather than "the secret was never set" — and every inbound text
    // silently 500s forever until someone looks.
    console.error("[sendblueWebhook] rejected: SENDBLUE_SIGNING_SECRET is not set (wrangler secret put SENDBLUE_SIGNING_SECRET) — no inbound text can be processed until it is");
    return c.json({ error: "webhook not configured" }, 503);
  }

  const providedSecret = c.req.header("sb-signing-secret");
  if (!providedSecret || !timingSafeEqual(providedSecret, signingSecret)) {
    console.error(
      `[sendblueWebhook] rejected: ${providedSecret ? "sb-signing-secret header did not match SENDBLUE_SIGNING_SECRET" : "no sb-signing-secret header on the request"} — check the signing secret configured on the Sendblue webhook matches the deployed secret`,
    );
    return c.json({ error: "invalid signing secret" }, 401);
  }

  let payload: InboundWebhookPayload;
  try {
    payload = await c.req.json<InboundWebhookPayload>();
  } catch (err) {
    console.error(`[sendblueWebhook] dropped: body was not valid JSON: ${describeError(err)}`);
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (payload.is_outbound) {
    console.log(`[sendblueWebhook] status callback for our own send (handle=${payload.message_handle ?? "none"}, status=${payload.status ?? "?"}) — not a reply`);
    return c.json({ ok: true });
  }

  const fromNumber = normalizePhone(payload.from_number ?? payload.number);
  if (!fromNumber || !payload.message_handle) {
    console.error(
      `[sendblueWebhook] dropped: missing from_number/number or message_handle (handle=${payload.message_handle ?? "none"}, payload keys: ${Object.keys(payload ?? {}).join(",")})`,
    );
    return c.json({ ok: true });
  }

  const existing = await findInboundMessageByHandle(c.env.DB, payload.message_handle);
  if (existing) {
    console.log(`[sendblueWebhook] redelivery of ${payload.message_handle} — already recorded, skipping`);
    return c.json({ ok: true });
  }

  // Exact E.164 first; the suffix match is the recovery path for a
  // from_number whose formatting normalizePhone can't fully reconcile with
  // what was stored at verification time. A suffix hit is logged loudly —
  // it means the stored number should be re-verified in its canonical
  // form, even though the reply itself is processed normally.
  let user = await findUserByVerifiedPhone(c.env.DB, fromNumber);
  if (!user) {
    user = await findUserByVerifiedPhoneSuffix(c.env.DB, fromNumber);
    if (user) {
      console.warn(
        `[sendblueWebhook] from_number=${fromNumber} matched user ${user.id} only on its last 10 digits (stored as ${user.phone_e164}) — re-verify that number in E.164 form to make this an exact match`,
      );
    }
  }

  if (!user) {
    // The one silent-drop this route used to have: a reply from a number
    // that doesn't match any verified user just vanished, with no signal
    // anywhere that it was ever received. Log it loudly — this is the
    // first thing to check when "I replied and nothing happened" comes
    // up. We deliberately do not text back here: the number is unverified,
    // and §10 forbids an unverified number eliciting any response at all.
    console.error(
      `[sendblueWebhook] no verified user for from_number=${fromNumber} (handle=${payload.message_handle}) — message recorded but NOT queued. Verify this number on a household member (POST /api/households/:householdId/users/:userId/verify-phone) for replies from it to be processed.`,
    );
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
    try {
      await c.env.TRANSACTION_QUEUE.send(message);
    } catch (err) {
      // A failed enqueue used to surface as a 500 from the generic error
      // handler, leaving a recorded-but-never-processed row behind and no
      // indication which half failed.
      console.error(`[sendblueWebhook] TRANSACTION_QUEUE.send failed for inbound ${inboundMessage.id}: ${describeError(err)}`);
      return c.json({ error: "could not queue message" }, 500);
    }
    console.log(`[sendblueWebhook] queued resolve_reply for household ${user.household_id} (inbound=${inboundMessage.id}, handle=${payload.message_handle})`);
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
