import { getAccount, updateAccount } from "../db/accounts";
import { getPlaidAccessToken, getPlaidItemByPlaidId, setPlaidItemStatus } from "../db/plaidItems";
import { deleteTransactionsForAccount } from "../db/transactions";
import { getEncryptionKey, getPlaidConfig } from "../lib/secrets";
import { describeError } from "../lib/errors";
import type { Env } from "../types";
import { itemRemove, PlaidApiError } from "./client";

export class AccountNotPlaidLinkedError extends Error {
  constructor(accountId: string) {
    super(`account ${accountId} is not Plaid-linked`);
    this.name = "AccountNotPlaidLinkedError";
  }
}

export interface UnlinkResult {
  transactionsDeleted: number;
}

/**
 * Unlinks a Plaid-connected account: tells Plaid to release the Item,
 * marks it and the account removed locally, and optionally purges every
 * transaction it ever synced. The two local writes always happen even if
 * the Plaid call fails — an access token issued under a different Plaid
 * environment (e.g. a Sandbox item, now that PLAID_ENV is production)
 * will never authenticate, and that's expected, not a reason to leave
 * dead test data stuck in the household forever. A real, currently-valid
 * item's removal call should succeed and release billing/webhooks on
 * Plaid's side; either way, the local account stops being synced.
 */
export async function unlinkPlaidAccount(env: Env, householdId: string, accountId: string, opts: { deleteTransactions: boolean }): Promise<UnlinkResult> {
  const account = await getAccount(env.DB, householdId, accountId);
  if (!account.plaid_item_id) throw new AccountNotPlaidLinkedError(accountId);

  const plaidItem = await getPlaidItemByPlaidId(env.DB, account.plaid_item_id);
  if (plaidItem && plaidItem.household_id === householdId) {
    try {
      const plaidConfig = getPlaidConfig(env);
      const encryptionKey = await getEncryptionKey(env);
      const accessToken = await getPlaidAccessToken(plaidItem, encryptionKey);
      await itemRemove(plaidConfig, accessToken);
    } catch (err) {
      // Expected and harmless for a stale/cross-environment item — log and
      // keep going. A real failure here (network, bad secrets) still
      // shouldn't block the household from getting rid of the account
      // locally; there's nothing left to retry once they've asked to
      // unlink it.
      const reason = err instanceof PlaidApiError ? err.message : describeError(err);
      console.log(`[unlink] Plaid item/remove failed for ${plaidItem.plaid_item_id} (continuing with local cleanup): ${reason}`);
    }
    await setPlaidItemStatus(env.DB, plaidItem.plaid_item_id, "removed");
  }

  await updateAccount(env.DB, householdId, accountId, { status: "removed" });

  const transactionsDeleted = opts.deleteTransactions ? await deleteTransactionsForAccount(env.DB, householdId, accountId) : 0;
  return { transactionsDeleted };
}
