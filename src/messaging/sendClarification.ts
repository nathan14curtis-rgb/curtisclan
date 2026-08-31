import { getClarification, markClarificationSent } from "../db/clarifications";
import { listVerifiedUsersForHousehold } from "../db/users";
import type { Env, User } from "../types";
import { sendToHouseholdGroup } from "./groupChat";
import { isWithinQuietHours, localHourMinute, minutesUntilQuietHoursEnd, type QuietHoursWindow } from "./quietHours";

// Cloudflare Queues' per-message delaySeconds cap.
const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;

/** The household's quiet hours are the union of everyone's — a message
 * that would wake either spouse waits, using whichever of their windows
 * ends latest. A user with no quiet hours configured never blocks it. */
export function householdQuietDelaySeconds(users: User[], now: Date): number {
  let maxDelaySeconds = 0;
  for (const user of users) {
    if (!user.quiet_hours_start || !user.quiet_hours_end) continue;
    const { hour, minute } = localHourMinute(now, user.timezone);
    const window: QuietHoursWindow = { start: user.quiet_hours_start, end: user.quiet_hours_end };
    if (isWithinQuietHours(hour, minute, window)) {
      maxDelaySeconds = Math.max(maxDelaySeconds, minutesUntilQuietHoursEnd(hour, minute, window) * 60);
    }
  }
  return maxDelaySeconds;
}

/**
 * Sends one clarification's question to the household's shared iMessage
 * group (PLAN.md §5.5), or — during quiet hours for anyone in the
 * household — re-queues itself with a delay instead ("queue overnight,
 * send in the morning"). Serialized send order/rate is the MESSAGE_QUEUE
 * consumer's low concurrency setting (wrangler.jsonc), not anything in
 * this function — PLAN.md §5.0's "make sure the send path queues rather
 * than fires in parallel."
 */
export async function processSendClarification(
  env: Env,
  householdId: string,
  clarificationId: string,
  requeue: (delaySeconds: number) => Promise<void>,
): Promise<void> {
  const clarification = await getClarification(env.DB, householdId, clarificationId);
  if (clarification.status !== "queued") {
    console.log(`[send_clarification] ${clarificationId} already ${clarification.status} — skipping`);
    return;
  }

  const users = await listVerifiedUsersForHousehold(env.DB, householdId);
  if (users.length === 0) {
    console.log(`[send_clarification] ${clarificationId} nobody verified — skipping`);
    return;
  }

  const delaySeconds = householdQuietDelaySeconds(users, new Date());
  if (delaySeconds > 0) {
    console.log(`[send_clarification] ${clarificationId} within quiet hours — requeuing for ${delaySeconds}s`);
    await requeue(Math.min(delaySeconds, MAX_QUEUE_DELAY_SECONDS));
    return;
  }

  const { messageHandle } = await sendToHouseholdGroup(env, householdId, clarification.question_text ?? "What was this charge?");
  console.log(`[send_clarification] ${clarificationId} sent, messageHandle=${messageHandle ?? "none"}`);
  if (messageHandle) await markClarificationSent(env.DB, clarification.id, messageHandle);
}
