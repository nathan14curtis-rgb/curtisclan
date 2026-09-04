import { listCategories } from "../db/categories";
import { listHouseholds } from "../db/households";
import { listRecentlyCategorizedTransactions } from "../db/transactions";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { recordAssistantMessage, AUTO_CATEGORIZED_WINDOW_HOURS } from "./agent";
import { sendToHouseholdGroup } from "./groupChat";

/** One day, exactly — the household's rule for what the bot may bring up
 * on its own about charges it filed by itself. The same constant bounds
 * what a reply can correct (src/messaging/agent.ts), so everything in this
 * message is answerable and nothing outside it gets raised. */
const DIGEST_WINDOW_HOURS = AUTO_CATEGORIZED_WINDOW_HOURS;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Cron-triggered fan-out, same pattern as enqueueHourlyCheckin: one
 * queued send per household rather than doing the work inline in the
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
 * The day's automatic filings, and an open invitation to correct any of
 * them in plain English. Only what the app decided by itself is listed
 * (`autoOnly`) — reporting back a charge someone categorized by text an
 * hour ago, to the person who categorized it, is noise.
 *
 * The reply path is the conversation itself (src/messaging/agent.ts): this
 * message is recorded as a turn in the thread, so "the second one was
 * actually a gift" resolves against exactly what was sent.
 */
export async function sendDailyDigest(env: Env, householdId: string): Promise<void> {
  const since = isoHoursAgo(DIGEST_WINDOW_HOURS);
  const [transactions, categories] = await Promise.all([
    listRecentlyCategorizedTransactions(env.DB, householdId, since, { autoOnly: true }),
    listCategories(env.DB, householdId),
  ]);
  if (transactions.length === 0) return; // nothing filed automatically in the window — skip the text rather than send an empty one

  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
  const lines = transactions.map((t) => {
    const dollars = (Math.abs(t.amount_cents) / 100).toFixed(2);
    const merchant = t.normalized_merchant ?? t.raw_description;
    const categoryName = (t.category_id && categoryNameById.get(t.category_id)) ?? "Uncategorized";
    return `$${dollars} ${merchant} → ${categoryName}`;
  });

  const text = [
    "Here's what I filed in the last 24 hours:",
    ...lines,
    "",
    'Tell me if I got any of them wrong — or ask me anything about the budget.',
  ].join("\n");

  await sendToHouseholdGroup(env, householdId, text);
  await recordAssistantMessage(env, householdId, text);
}
