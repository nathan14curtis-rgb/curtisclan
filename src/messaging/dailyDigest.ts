import { listCategories } from "../db/categories";
import { listHouseholds } from "../db/households";
import { listRecentlyCategorizedTransactions } from "../db/transactions";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { sendToHouseholdGroup } from "./groupChat";

// Wide enough to reliably cover "yesterday" regardless of the household's
// timezone and the cron's exact fire time — a couple of double-reported
// transactions in the digest is harmless, missing one isn't.
const DIGEST_WINDOW_HOURS = 36;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Cron-triggered fan-out, same pattern as enqueueNightlyReconciliation:
 * one queued send per household rather than doing the work inline in the
 * scheduled() handler, so a slow/failing send for one household doesn't
 * block or retry the others. */
export async function enqueueDailyDigest(env: Env): Promise<number> {
  const households = await listHouseholds(env.DB);
  for (const household of households) {
    const message: MessageQueueMessage = { type: "daily_digest", householdId: household.id };
    await env.MESSAGE_QUEUE.send(message);
  }
  return households.length;
}

/**
 * "Yesterday's transactions, and the ability to text back and
 * recategorize" — lists what got auto-filed since the last digest window,
 * with an explicit invitation to correct anything in plain English. The
 * actual correction handling reuses the same recently-categorized pool
 * this reads from (src/messaging/inboundProcessing.ts), so a reply like
 * "actually the uber was for business" needs no special "fix" syntax.
 */
export async function sendDailyDigest(env: Env, householdId: string): Promise<void> {
  const since = isoHoursAgo(DIGEST_WINDOW_HOURS);
  const [transactions, categories] = await Promise.all([
    listRecentlyCategorizedTransactions(env.DB, householdId, since),
    listCategories(env.DB, householdId),
  ]);
  if (transactions.length === 0) return; // nothing categorized in the window — skip the text rather than send an empty one

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const lines = transactions.map((t) => {
    const dollars = (Math.abs(t.amount_cents) / 100).toFixed(2);
    const merchant = t.normalized_merchant ?? t.raw_description;
    const categoryName = (t.category_id && categoryNameById.get(t.category_id)) ?? "Uncategorized";
    return `$${dollars} ${merchant} → ${categoryName}`;
  });

  const text = [
    "Yesterday's transactions:",
    ...lines,
    "",
    'Reply to recategorize anything — e.g. "actually the uber was for business".',
  ].join("\n");

  await sendToHouseholdGroup(env, householdId, text);
}
