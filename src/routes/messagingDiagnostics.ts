import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { getHousehold } from "../db/households";
import { listInboundMessagesForDiagnostics } from "../db/inboundMessages";
import { listUsers } from "../db/users";

export const messagingDiagnosticsRoute = new Hono<{ Bindings: Env }>();

/**
 * Answers "I texted the bot and nothing happened" from stored state alone,
 * without needing a live `wrangler tail`.
 *
 * Every way the inbound loop can fail is silent by design — an unset
 * secret, a Sendblue webhook pointed at the wrong URL, a number that was
 * never verified, and a reply that resolved to nothing all look identical
 * from the phone. This reports each of them separately:
 *
 *   - `config`     — which secrets the deployed Worker actually has, and
 *                    whether the group thread has been created yet.
 *   - `people`     — who can send and receive, i.e. whose replies will be
 *                    matched to this household at all.
 *   - `inbound`    — the last texts Sendblue delivered. `matchedUser: false`
 *                    means the webhook fired but the number matched no
 *                    verified user; an empty list means Sendblue never
 *                    reached the Worker, which points at the webhook URL
 *                    or the signing secret rather than at anything here.
 *   - `unprocessed`— received and queued but never finished.
 */
messagingDiagnosticsRoute.get("/diagnostics", async (c) => {
  const householdId = requireParam(c, "householdId");
  const household = await getHousehold(c.env.DB, householdId);
  const [users, inbound] = await Promise.all([
    listUsers(c.env.DB, householdId),
    listInboundMessagesForDiagnostics(c.env.DB, householdId, 20),
  ]);

  const verified = users.filter((u) => u.phone_verified_at !== null);

  return c.json({
    config: {
      // Presence only — never the values themselves.
      sendblueSigningSecretSet: Boolean(c.env.SENDBLUE_SIGNING_SECRET),
      sendblueApiKeySet: Boolean(c.env.SENDBLUE_API_KEY_ID && c.env.SENDBLUE_API_SECRET_KEY),
      sendblueFromNumberSet: Boolean(c.env.SENDBLUE_FROM_NUMBER),
      anthropicApiKeySet: Boolean(c.env.ANTHROPIC_API_KEY),
      groupChatCreated: Boolean(household.group_chat_id),
      webhookUrlToConfigureInSendblue: new URL("/webhooks/sendblue", c.req.url).toString(),
    },
    people: {
      verifiedCount: verified.length,
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        phoneE164: u.phone_e164,
        verified: u.phone_verified_at !== null,
      })),
    },
    inbound: inbound.map((m) => ({
      id: m.id,
      receivedAt: m.received_at,
      fromNumber: m.from_number,
      content: m.content,
      // false = the webhook fired but no verified user owns this number,
      // so the reply was recorded and then deliberately never queued.
      matchedUser: m.household_id !== null,
      processedAt: m.processed_at,
    })),
    unprocessed: inbound.filter((m) => m.household_id !== null && m.processed_at === null).length,
    unmatchedNumbers: [...new Set(inbound.filter((m) => m.household_id === null).map((m) => m.from_number))],
  });
});
