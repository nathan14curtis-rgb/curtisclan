import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount, getAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { applyCategorization, createTransaction, deleteTransactionsForAccount, listTransactions } from "../src/db/transactions";
import { listClassifications } from "../src/db/classifications";
import { createClarification, getLatestClarificationForTransaction } from "../src/db/clarifications";
import { createPlaidItem, getPlaidItemByPlaidId } from "../src/db/plaidItems";
import { getEncryptionKey } from "../src/lib/secrets";
import { AccountNotPlaidLinkedError, unlinkPlaidAccount } from "../src/plaid/unlink";

const db = env.DB;

beforeEach(() => {
  Object.assign(env, {
    PLAID_CLIENT_ID: "test-client-id",
    PLAID_SECRET: "test-secret",
    PLAID_ENV: "sandbox",
    // 32 raw bytes, base64-encoded — same shape as a real TOKEN_ENCRYPTION_KEY secret.
    TOKEN_ENCRYPTION_KEY: (() => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      let binary = "";
      for (const b of raw) binary += String.fromCharCode(b);
      return btoa(binary);
    })(),
  });
});

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  return { household, nathan, groceries };
}

async function seedPlaidLinkedAccount(householdId: string) {
  const key = await getEncryptionKey(env);
  const item = await createPlaidItem(db, householdId, { plaidItemId: "plaid-item-1", accessToken: "sandbox-access-token" }, key);
  const account = await createAccount(db, householdId, {
    name: "Sandbox Checking",
    type: "depository_checking",
    plaidItemId: item.plaid_item_id,
    plaidAccountId: "plaid-account-1",
  });
  return { item, account };
}

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("deleteTransactionsForAccount", () => {
  it("deletes every transaction on the account plus its classification/clarification children, leaves other accounts alone", async () => {
    const { household, nathan, groceries } = await seedHousehold();
    const target = await createAccount(db, household.id, { name: "Target", type: "depository_checking" });
    const other = await createAccount(db, household.id, { name: "Other", type: "depository_checking" });

    const txn1 = await createTransaction(db, household.id, { accountId: target.id, postedAt: "2026-01-01", amountCents: -1000, rawDescription: "A" });
    await applyCategorization(db, household.id, txn1.id, { categoryId: groceries.id, method: "human" });
    const txn2 = await createTransaction(db, household.id, { accountId: target.id, postedAt: "2026-01-02", amountCents: -2000, rawDescription: "B" });
    await createClarification(db, household.id, { transactionId: txn2.id, userId: nathan.id, questionText: "What was this?" });
    const otherTxn = await createTransaction(db, household.id, { accountId: other.id, postedAt: "2026-01-01", amountCents: -500, rawDescription: "C" });

    const deleted = await deleteTransactionsForAccount(db, household.id, target.id);
    expect(deleted).toBe(2);

    expect(await listTransactions(db, household.id, { accountId: target.id })).toHaveLength(0);
    expect(await listClassifications(db, household.id, txn1.id)).toHaveLength(0);
    expect(await getLatestClarificationForTransaction(db, household.id, txn2.id)).toBeNull();

    const otherRemaining = await listTransactions(db, household.id, { accountId: other.id });
    expect(otherRemaining.map((t) => t.id)).toEqual([otherTxn.id]);
  });

  it("is a no-op returning 0 when the account has no transactions", async () => {
    const { household } = await seedHousehold();
    const account = await createAccount(db, household.id, { name: "Empty", type: "depository_checking" });
    expect(await deleteTransactionsForAccount(db, household.id, account.id)).toBe(0);
  });
});

describe("unlinkPlaidAccount", () => {
  it("rejects an account that was never Plaid-linked", async () => {
    const { household } = await seedHousehold();
    const manual = await createAccount(db, household.id, { name: "Manual", type: "depository_checking" });
    await expect(unlinkPlaidAccount(env, household.id, manual.id, { deleteTransactions: false })).rejects.toThrow(AccountNotPlaidLinkedError);
  });

  it("marks the item and account removed, and keeps transactions when deleteTransactions is false", async () => {
    const { household, groceries } = await seedHousehold();
    const { item, account } = await seedPlaidLinkedAccount(household.id);
    await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-01-01", amountCents: -1000, rawDescription: "A", source: "plaid" });
    mockFetchOnce(200, {});

    const result = await unlinkPlaidAccount(env, household.id, account.id, { deleteTransactions: false });
    expect(result.transactionsDeleted).toBe(0);

    const updatedAccount = await getAccount(db, household.id, account.id);
    expect(updatedAccount.status).toBe("removed");
    const updatedItem = await getPlaidItemByPlaidId(db, item.plaid_item_id);
    expect(updatedItem?.status).toBe("removed");
    expect(await listTransactions(db, household.id, { accountId: account.id })).toHaveLength(1);
    expect(groceries.id).toBeTruthy(); // seeded taxonomy, unused directly here
  });

  it("deletes transactions when deleteTransactions is true", async () => {
    const { household } = await seedHousehold();
    const { account } = await seedPlaidLinkedAccount(household.id);
    await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-01-01", amountCents: -1000, rawDescription: "A", source: "plaid" });
    await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-01-02", amountCents: -2000, rawDescription: "B", source: "plaid" });
    mockFetchOnce(200, {});

    const result = await unlinkPlaidAccount(env, household.id, account.id, { deleteTransactions: true });
    expect(result.transactionsDeleted).toBe(2);
    expect(await listTransactions(db, household.id, { accountId: account.id })).toHaveLength(0);
  });

  // The exact situation that motivated this: a Sandbox-issued access
  // token will never authenticate once PLAID_ENV is production (or vice
  // versa) — Plaid's /item/remove call is expected to fail here, and that
  // must not block unlinking the account locally.
  it("still completes local cleanup when Plaid's item/remove call fails (stale/cross-environment token)", async () => {
    const { household } = await seedHousehold();
    const { item, account } = await seedPlaidLinkedAccount(household.id);
    await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-01-01", amountCents: -1000, rawDescription: "A", source: "plaid" });
    mockFetchOnce(400, { error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN", error_message: "the access token is not valid" });

    const result = await unlinkPlaidAccount(env, household.id, account.id, { deleteTransactions: true });
    expect(result.transactionsDeleted).toBe(1);

    const updatedAccount = await getAccount(db, household.id, account.id);
    expect(updatedAccount.status).toBe("removed");
    const updatedItem = await getPlaidItemByPlaidId(db, item.plaid_item_id);
    expect(updatedItem?.status).toBe("removed");
  });
});
