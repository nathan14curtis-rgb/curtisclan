import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { listActivePlaidItems } from "../db/plaidItems";

/** "Nightly cron reconciliation to catch dropped webhooks. They get
 * dropped." (PLAN.md §4.2) Re-syncs every active item; each sync is a
 * no-op past its cursor when nothing changed, so this is cheap insurance,
 * not a full backfill. */
export async function enqueueNightlyReconciliation(env: Env): Promise<number> {
  const items = await listActivePlaidItems(env.DB);
  for (const item of items) {
    const message: TransactionQueueMessage = { type: "plaid_sync", householdId: item.household_id, plaidItemId: item.plaid_item_id };
    await env.TRANSACTION_QUEUE.send(message);
  }
  return items.length;
}
