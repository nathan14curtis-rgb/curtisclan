import { getClarification, markClarificationSent } from "../db/clarifications";
import { getUser } from "../db/users";
import { getSendblueConfig } from "../lib/secrets";
import { sendMessage } from "../sendblue/client";
import type { Env } from "../types";
import { isWithinQuietHours, localHourMinute, minutesUntilQuietHoursEnd } from "./quietHours";

// Cloudflare Queues' per-message delaySeconds cap.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

/**
 * Sends one clarification's question over iMessage (PLAN.md §5.5), or —
 * during quiet hours — re-queues itself with a delay instead ("queue
 * overnight, send in the morning"). Serialized send order/rate is the
 * MESSAGE_QUEUE consumer's low concurrency setting (wrangler.jsonc), not
 * anything in this function — PLAN.md §5.0's "make sure the send path
 * queues rather than fires in parallel."
 */
export async function processSendClarification(
  env: Env,
  householdId: string,
  clarificationId: string,
  requeue: (delaySeconds: number) => Promise<void>,
): Promise<void> {
  const clarification = await getClarification(env.DB, householdId, clarificationId);
  if (clarification.status !== "queued") return; // redelivered after already being sent/answered — no-op

  const user = await getUser(env.DB, householdId, clarification.user_id);
  if (!user.phone_e164 || !user.phone_verified_at) return; // resolveAskee only ever picks a verified user; defensive

  if (user.quiet_hours_start && user.quiet_hours_end) {
    const { hour, minute } = localHourMinute(new Date(), user.timezone);
    const window = { start: user.quiet_hours_start, end: user.quiet_hours_end };
    if (isWithinQuietHours(hour, minute, window)) {
      const delaySeconds = Math.min(minutesUntilQuietHoursEnd(hour, minute, window) * 60, MAX_QUEUE_DELAY_SECONDS);
      await requeue(delaySeconds);
      return;
    }
  }

  const response = await sendMessage(getSendblueConfig(env), {
    to: user.phone_e164,
    content: clarification.question_text ?? "What was this charge?",
  });
  await markClarificationSent(env.DB, clarification.id, response.message_handle);
}
