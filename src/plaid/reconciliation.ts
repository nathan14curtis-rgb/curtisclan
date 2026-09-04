import type { TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { listActivePlaidItems } from "../db/plaidItems";

/**
 * The hourly pull. Every active item runs /transactions/sync once an hour
 * (src/index.ts's HOURLY_SYNC_CRON), which is both how new charges arrive
 * on a predictable cadence and how a dropped webhook stops mattering
 * ("Nightly cron reconciliation to catch dropped webhooks. They get
 * dropped." — PLAN.md §4.2; hourly is the same insurance, just an hour
 * stale at worst instead of a day).
 *
 * Cheap by construction: a sync past its cursor with nothing new returns
 * an empty page, so an idle hour costs one Plaid call per item and no
 * writes. Plaid's TRANSACTIONS webhook still fires the same job the moment
 * something lands — this is the floor, not the only path.
 */
export async function enqueueHourlyPlaidSync(env: Env): Promise<number> {
  const items = await listActivePlaidItems(env.DB);
  for (const item of items) {
    const message: TransactionQueueMessage = { type: "plaid_sync", householdId: item.household_id, plaidItemId: item.plaid_item_id };
    await env.TRANSACTION_QUEUE.send(message);
  }
  return items.length;
}
