import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { applyCategorization, createTransaction, listTransactionsWithVerifyState, unverifyTransaction, verifyTransaction } from "../src/db/transactions";
import { NotFoundError } from "../src/db/client";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  return { household, nathan, account, groceries };
}

describe("verifyTransaction / unverifyTransaction", () => {
  it("round-trips verified_by_user_id and verified_at", async () => {
    const { household, nathan, account } = await seedHousehold();
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });

    const verified = await verifyTransaction(db, household.id, txn.id, nathan.id);
    expect(verified.verified_by_user_id).toBe(nathan.id);
    expect(verified.verified_at).not.toBeNull();

    const unverified = await unverifyTransaction(db, household.id, txn.id);
    expect(unverified.verified_by_user_id).toBeNull();
    expect(unverified.verified_at).toBeNull();
  });

  it("404s on a transaction id from a different household", async () => {
    const { household, nathan, account } = await seedHousehold();
    const other = await createHousehold(db, { name: "Someone Else" });
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -500, rawDescription: "SHOP" });
    await expect(verifyTransaction(db, other.id, txn.id, nathan.id)).rejects.toThrow(NotFoundError);
  });
});

describe("listTransactionsWithVerifyState", () => {
  it("is 'me' once explicitly verified, regardless of classification history", async () => {
    const { household, nathan, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "rule" });
    await verifyTransaction(db, household.id, txn.id, nathan.id);

    const [row] = await listTransactionsWithVerifyState(db, household.id, { accountId: account.id });
    expect(row!.verify_state).toBe("me");
  });

  it("is 'ai' for a rule/memory/llm classification that was never explicitly verified", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "memory", confidence: 0.9 });

    const [row] = await listTransactionsWithVerifyState(db, household.id, { accountId: account.id });
    expect(row!.verify_state).toBe("ai");
  });

  it("is 'none' for an uncategorized transaction", async () => {
    const { household, account } = await seedHousehold();
    await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });

    const [row] = await listTransactionsWithVerifyState(db, household.id, { accountId: account.id });
    expect(row!.verify_state).toBe("none");
  });

  it("is 'none' for a human dropdown edit that was never explicitly verified — a category being right isn't the same claim as verified", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "human" });

    const [row] = await listTransactionsWithVerifyState(db, household.id, { accountId: account.id });
    expect(row!.verify_state).toBe("none");
  });

  it("uses the most recent classification, not the first, when a category was corrected", async () => {
    const { household, account, groceries } = await seedHousehold();
    const categories = await listCategories(db, household.id);
    const dining = categories.find((c) => c.name === "Dining Out")!;
    const txn = await createTransaction(db, household.id, { accountId: account.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "SHOP" });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "rule" });
    await applyCategorization(db, household.id, txn.id, { categoryId: dining.id, method: "human" });

    const [row] = await listTransactionsWithVerifyState(db, household.id, { accountId: account.id });
    // Latest classification is the human correction, unverified — "none", not "ai".
    expect(row!.verify_state).toBe("none");
  });
});
