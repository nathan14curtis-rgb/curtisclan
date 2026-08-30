import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import {
  createAccount,
  getAccount,
  getAccountByPlaidAccountId,
  markAccountsLoginRequiredForItem,
  reactivateAccountsForItem,
  updateAccountBalance,
} from "../src/db/accounts";
import { createPlaidItem, getPlaidAccessToken, getPlaidItemByPlaidId, listActivePlaidItems, setPlaidItemStatus, updateSyncCursor } from "../src/db/plaidItems";
import { listCategories } from "../src/db/categories";
import { createTransaction, getTransaction } from "../src/db/transactions";
import { detectAndMarkTransfer } from "../src/db/transfers";
import { createClarification, getLatestClarificationForTransaction, listOpenClarificationsForUser, markClarificationAnswered, markClarificationSent, resolveAskee } from "../src/db/clarifications";
import { createInboundMessage, findInboundMessageByHandle } from "../src/db/inboundMessages";
import { importEncryptionKey } from "../src/lib/crypto";
import { categorizeTransaction } from "../src/categorization/pipeline";
import { createRule } from "../src/db/rules";
import { reinforceMerchantMemory } from "../src/db/merchantMemory";

const db = env.DB;

async function testEncryptionKey(): Promise<CryptoKey> {
  // 32 raw bytes, base64-encoded — same shape as a real TOKEN_ENCRYPTION_KEY secret.
  const raw = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return importEncryptionKey(btoa(binary));
}

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, nathan.id, "+13035551234");
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  const amex = await createAccount(db, household.id, { name: "Amex", type: "credit_card", ownerUserId: nathan.id });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  return { household, nathan, checking, amex, groceries };
}

describe("plaid_item", () => {
  it("encrypts the access token at rest and decrypts it back", async () => {
    const { household } = await seedHousehold();
    const key = await testEncryptionKey();
    const item = await createPlaidItem(db, household.id, { plaidItemId: "item-abc", accessToken: "access-sandbox-secret-value" }, key);

    expect(item.access_token_ciphertext).not.toContain("access-sandbox-secret-value");
    const decrypted = await getPlaidAccessToken(item, key);
    expect(decrypted).toBe("access-sandbox-secret-value");
  });

  it("fails to decrypt with the wrong key", async () => {
    const { household } = await seedHousehold();
    const key = await testEncryptionKey();
    const wrongKey = await testEncryptionKey();
    const item = await createPlaidItem(db, household.id, { plaidItemId: "item-xyz", accessToken: "secret" }, key);
    await expect(getPlaidAccessToken(item, wrongKey)).rejects.toThrow();
  });

  it("tracks the sync cursor and only lists active items", async () => {
    const { household } = await seedHousehold();
    const key = await testEncryptionKey();
    await createPlaidItem(db, household.id, { plaidItemId: "item-cursor", accessToken: "t" }, key);

    await updateSyncCursor(db, "item-cursor", "cursor-1");
    const fetched = await getPlaidItemByPlaidId(db, "item-cursor");
    expect(fetched?.cursor).toBe("cursor-1");

    const activeBefore = await listActivePlaidItems(db);
    expect(activeBefore.some((i) => i.plaid_item_id === "item-cursor")).toBe(true);

    await setPlaidItemStatus(db, "item-cursor", "login_required");
    const activeAfter = await listActivePlaidItems(db);
    expect(activeAfter.some((i) => i.plaid_item_id === "item-cursor")).toBe(false);
  });
});

describe("account balances and login-required propagation", () => {
  it("updates a balance and surfaces it on the account row", async () => {
    const { household, checking } = await seedHousehold();
    await updateAccountBalance(db, checking.id, 100000, 95000);
    const fetched = await getAccount(db, household.id, checking.id);
    expect(fetched.current_balance_cents).toBe(100000);
    expect(fetched.available_balance_cents).toBe(95000);
  });

  it("flips every account under an item to login_required together, and back", async () => {
    const { household } = await seedHousehold();
    const acct = await createAccount(db, household.id, { name: "Discover", type: "credit_card", plaidItemId: "item-shared" });

    await markAccountsLoginRequiredForItem(db, household.id, "item-shared");
    expect((await getAccount(db, household.id, acct.id)).status).toBe("login_required");

    await reactivateAccountsForItem(db, household.id, "item-shared");
    expect((await getAccount(db, household.id, acct.id)).status).toBe("active");
  });

  it("looks accounts up by their Plaid account id", async () => {
    const { household } = await seedHousehold();
    const acct = await createAccount(db, household.id, { name: "Savings", type: "depository_savings", plaidAccountId: "plaid-acct-1" });
    const found = await getAccountByPlaidAccountId(db, "plaid-acct-1");
    expect(found?.id).toBe(acct.id);
  });
});

describe("detectAndMarkTransfer", () => {
  it("marks both legs of a card payment as transfers", async () => {
    const { household, checking, amex } = await seedHousehold();
    const debit = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -50000, rawDescription: "AMEX PAYMENT",
    });
    const credit = await createTransaction(db, household.id, {
      accountId: amex.id, postedAt: "2026-03-11", amountCents: 50000, rawDescription: "PAYMENT THANK YOU",
    });

    const matched = await detectAndMarkTransfer(db, household.id, { id: debit.id, accountId: checking.id, amountCents: -50000, postedAt: "2026-03-10" });
    expect(matched).toBe(true);

    expect((await getTransaction(db, household.id, debit.id)).is_transfer).toBe(1);
    expect((await getTransaction(db, household.id, credit.id)).is_transfer).toBe(1);
  });

  it("does not mark an ordinary purchase as a transfer", async () => {
    const { household, checking } = await seedHousehold();
    const purchase = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4500, rawDescription: "WALMART",
    });
    const matched = await detectAndMarkTransfer(db, household.id, { id: purchase.id, accountId: checking.id, amountCents: -4500, postedAt: "2026-03-10" });
    expect(matched).toBe(false);
    expect((await getTransaction(db, household.id, purchase.id)).is_transfer).toBe(0);
  });
});

describe("clarifications", () => {
  it("resolves the account owner as the askee when verified", async () => {
    const { household, nathan, checking } = await seedHousehold();
    const askee = await resolveAskee(db, household.id, checking);
    expect(askee?.id).toBe(nathan.id);
  });

  it("falls back to any verified household user when the account has no owner", async () => {
    const { household, nathan } = await seedHousehold();
    const joint = await createAccount(db, household.id, { name: "Joint Savings", type: "depository_savings" });
    const askee = await resolveAskee(db, household.id, joint);
    expect(askee?.id).toBe(nathan.id);
  });

  it("tracks the send/answer lifecycle and lists only 'sent' as open", async () => {
    const { household, nathan, checking } = await seedHousehold();
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-03-10", amountCents: -1000, rawDescription: "X" });
    const clarification = await createClarification(db, household.id, { transactionId: txn.id, userId: nathan.id, questionText: "What was this?" });

    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(0); // still 'queued', not 'sent'

    await markClarificationSent(db, clarification.id, "sb-handle-1");
    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(1);

    await markClarificationAnswered(db, clarification.id);
    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(0);

    const latest = await getLatestClarificationForTransaction(db, household.id, txn.id);
    expect(latest?.status).toBe("answered");
  });
});

describe("inbound_message dedupe", () => {
  it("is idempotent by message_handle", async () => {
    const { household, nathan } = await seedHousehold();
    await createInboundMessage(db, {
      householdId: household.id, userId: nathan.id, fromNumber: "+13035551234",
      messageHandle: "handle-1", content: "walmart was groceries", receivedAt: "2026-03-10T12:00:00Z", rawPayload: { raw: true },
    });
    const found = await findInboundMessageByHandle(db, "handle-1");
    expect(found?.content).toBe("walmart was groceries");
  });
});

describe("categorizeTransaction pipeline", () => {
  it("applies a matching rule and never opens a clarification", async () => {
    const { household, nathan, checking, groceries } = await seedHousehold();
    await createRule(db, household.id, {
      conditions: { field: "merchant", op: "contains", value: "walmart" },
      actions: [{ type: "setCategory", categoryId: groceries.id }],
    });
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4500, rawDescription: "WALMART", normalizedMerchant: "WALMART",
    });

    await categorizeTransaction(env, household.id, txn.id);

    const updated = await getTransaction(db, household.id, txn.id);
    expect(updated.category_id).toBe(groceries.id);
    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(0);
  });

  it("applies a warm merchant-memory match without asking", async () => {
    const { household, nathan, checking, groceries } = await seedHousehold();
    for (let i = 0; i < 3; i++) {
      await reinforceMerchantMemory(db, household.id, "COSTCO", groceries.id, -8000);
    }
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -8000, rawDescription: "COSTCO", normalizedMerchant: "COSTCO",
    });

    await categorizeTransaction(env, household.id, txn.id);

    const updated = await getTransaction(db, household.id, txn.id);
    expect(updated.category_id).toBe(groceries.id);
    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(0);
  });

  it("asks a human and assigns no category when nothing matches and no LLM key is configured", async () => {
    const { household, nathan, checking } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -2200, rawDescription: "THE HIVE MERCANTILE", normalizedMerchant: "THE HIVE MERCANTILE",
    });

    // env.ANTHROPIC_API_KEY is unset in this test environment — the
    // cascade should fall through to layer 'none' cleanly (PLAN.md §5.5:
    // never block ingest on the LLM layer being unavailable).
    await categorizeTransaction(env, household.id, txn.id);

    const updated = await getTransaction(db, household.id, txn.id);
    expect(updated.category_id).toBeNull();

    const clarification = await getLatestClarificationForTransaction(db, household.id, txn.id);
    expect(clarification?.status).toBe("queued");
    expect(clarification?.question_text).toContain("THE HIVE MERCANTILE");
    expect(clarification?.user_id).toBe(nathan.id);
  });

  it("is idempotent — a redelivered job for an already-categorized transaction is a no-op", async () => {
    const { household, checking, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4500, rawDescription: "WALMART", normalizedMerchant: "WALMART",
    });
    await createRule(db, household.id, {
      conditions: { field: "merchant", op: "contains", value: "walmart" },
      actions: [{ type: "setCategory", categoryId: groceries.id }],
    });

    await categorizeTransaction(env, household.id, txn.id);
    await categorizeTransaction(env, household.id, txn.id); // redelivered

    const updated = await getTransaction(db, household.id, txn.id);
    expect(updated.category_id).toBe(groceries.id);
  });

  it("never asks about a transaction already marked as a transfer", async () => {
    const { household, nathan, checking, amex } = await seedHousehold();
    const debit = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-03-10", amountCents: -50000, rawDescription: "AMEX PAYMENT" });
    const credit = await createTransaction(db, household.id, { accountId: amex.id, postedAt: "2026-03-11", amountCents: 50000, rawDescription: "PAYMENT THANK YOU" });
    await detectAndMarkTransfer(db, household.id, { id: debit.id, accountId: checking.id, amountCents: -50000, postedAt: "2026-03-10" });

    await categorizeTransaction(env, household.id, debit.id);
    await categorizeTransaction(env, household.id, credit.id);

    expect(await listOpenClarificationsForUser(db, nathan.id)).toHaveLength(0);
  });
});
