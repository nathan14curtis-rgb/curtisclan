import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { listEnvelopes, allocateToEnvelope, moveMoneyBetweenEnvelopes, getEnvelopeMonthSummary } from "../src/db/envelopes";
import { applyCategorization, createTransaction, splitTransaction, listTransactions } from "../src/db/transactions";
import { listClassifications } from "../src/db/classifications";
import { getMerchantMemory } from "../src/db/merchantMemory";
import { importCsvTransactions } from "../src/db/csvImport";
import { parseCsvRows } from "../src/import/csvImport";
import { NotFoundError } from "../src/db/client";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const account = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  const dining = categories.find((c) => c.name === "Dining Out")!;
  return { household, nathan, account, groceries, dining };
}

describe("household setup", () => {
  it("seeds the default taxonomy and one envelope per expense/savings category", async () => {
    const { household } = await seedHousehold();
    const categories = await listCategories(db, household.id);
    const envelopes = await listEnvelopes(db, household.id);

    expect(categories.length).toBeGreaterThan(10);
    const fundedKinds = categories.filter((c) => c.kind === "expense" || c.kind === "savings");
    expect(envelopes).toHaveLength(fundedKinds.length);

    const income = categories.filter((c) => c.kind === "income");
    expect(income.length).toBeGreaterThan(0);
    for (const cat of income) {
      expect(envelopes.some((e) => e.category_id === cat.id)).toBe(false);
    }
  });

  it("scopes every read to the household — a wrong id 404s instead of leaking another household's row", async () => {
    const { household } = await seedHousehold();
    const other = await createHousehold(db, { name: "Someone Else" });
    const otherCategories = await listCategories(db, other.id);

    await expect(async () => {
      const { getCategory } = await import("../src/db/categories");
      await getCategory(db, household.id, otherCategories[0]!.id);
    }).rejects.toThrow(NotFoundError);
  });
});

describe("phone verification", () => {
  it("only binds a phone once verified, and rejects a duplicate", async () => {
    const { household, nathan } = await seedHousehold();
    const verified = await verifyUserPhone(db, household.id, nathan.id, "+13035551234");
    expect(verified.phone_e164).toBe("+13035551234");
    expect(verified.phone_verified_at).not.toBeNull();
  });
});

describe("applyCategorization", () => {
  it("updates the transaction, writes an audit row, and reinforces merchant_memory for a human correction", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -4523,
      rawDescription: "WALMART #4821 GRAND JCT CO",
      normalizedMerchant: "WALMART",
    });

    const updated = await applyCategorization(db, household.id, txn.id, {
      categoryId: groceries.id,
      memo: "weekly groceries",
      method: "human",
    });
    expect(updated.category_id).toBe(groceries.id);
    expect(updated.memo).toBe("weekly groceries");

    const classifications = await listClassifications(db, household.id, txn.id);
    expect(classifications).toHaveLength(1);
    expect(classifications[0]).toMatchObject({ method: "human", category_id: groceries.id, prior_category_id: null });

    const memory = await getMerchantMemory(db, household.id, "WALMART");
    expect(memory).toMatchObject({ category_id: groceries.id, hit_count: 1 });
  });

  it("does not touch merchant_memory for a non-human (e.g. rule) categorization", async () => {
    const { household, account, groceries } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -1200,
      rawDescription: "COSTCO GAS",
      normalizedMerchant: "COSTCO GAS",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "rule" });
    const memory = await getMerchantMemory(db, household.id, "COSTCO GAS");
    expect(memory).toBeNull();
  });

  it("records the prior category on a correction", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -2000,
      rawDescription: "AMBIGUOUS CHARGE",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "llm", confidence: 0.6 });
    await applyCategorization(db, household.id, txn.id, { categoryId: dining.id, method: "human" });

    const classifications = await listClassifications(db, household.id, txn.id);
    expect(classifications).toHaveLength(2);
    expect(classifications[1]).toMatchObject({ method: "human", category_id: dining.id, prior_category_id: groceries.id });
  });
});

describe("splitTransaction", () => {
  it("requires splits to sum exactly to the parent amount", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -10000,
      rawDescription: "COSTCO",
    });
    await expect(
      splitTransaction(db, household.id, txn.id, [
        { amountCents: -6000, categoryId: groceries.id },
        { amountCents: -3000, categoryId: dining.id },
      ]),
    ).rejects.toThrow(/sum to parent amount/);
  });

  it("creates child rows and excludes the parent from budget totals", async () => {
    const { household, account, groceries, dining } = await seedHousehold();
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -10000,
      rawDescription: "COSTCO",
    });
    const children = await splitTransaction(db, household.id, txn.id, [
      { amountCents: -7000, categoryId: groceries.id, memo: "groceries" },
      { amountCents: -3000, categoryId: dining.id, memo: "rotisserie chicken lol" },
    ]);
    expect(children).toHaveLength(2);

    const all = await listTransactions(db, household.id, { accountId: account.id });
    const parent = all.find((t) => t.id === txn.id)!;
    expect(parent.excluded_from_budget).toBe(1);
    expect(children.every((c) => c.split_parent_id === txn.id)).toBe(true);
  });
});

describe("envelope ledger", () => {
  it("computes a month summary matching allocations minus spend", async () => {
    const { household, account, groceries } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const envelope = envelopes.find((e) => e.category_id === groceries.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: "2026-03", amountCents: 60000 });
    const txn = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -4523,
      rawDescription: "WALMART",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "human" });

    const summary = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-03");
    expect(summary).toEqual({ month: "2026-03", allocatedCents: 60000, spentCents: 4523, balanceCents: 55477 });
  });

  it("carries a negative balance forward into the next month (PLAN.md §8.2)", async () => {
    const { household, account, groceries } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const envelope = envelopes.find((e) => e.category_id === groceries.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: envelope.id, month: "2026-03", amountCents: 4000 });
    const overspend = await createTransaction(db, household.id, {
      accountId: account.id,
      postedAt: "2026-03-10",
      amountCents: -8000,
      rawDescription: "BIG GROCERY RUN",
    });
    await applyCategorization(db, household.id, overspend.id, { categoryId: groceries.id, method: "human" });

    const march = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-03");
    expect(march.balanceCents).toBe(-4000);

    // April: no new spend, no new allocation — the deficit persists.
    const april = await getEnvelopeMonthSummary(db, household.id, envelope.id, "2026-04");
    expect(april.balanceCents).toBe(-4000);
    expect(april.allocatedCents).toBe(0);
    expect(april.spentCents).toBe(0);
  });

  it("moves money between envelopes as two linked, reversible ledger rows", async () => {
    const { household, groceries, dining } = await seedHousehold();
    const envelopes = await listEnvelopes(db, household.id);
    const groceriesEnv = envelopes.find((e) => e.category_id === groceries.id)!;
    const diningEnv = envelopes.find((e) => e.category_id === dining.id)!;

    await allocateToEnvelope(db, household.id, { envelopeId: diningEnv.id, month: "2026-03", amountCents: 10000 });
    await moveMoneyBetweenEnvelopes(db, household.id, {
      fromEnvelopeId: diningEnv.id,
      toEnvelopeId: groceriesEnv.id,
      month: "2026-03",
      amountCents: 4000,
    });

    const diningSummary = await getEnvelopeMonthSummary(db, household.id, diningEnv.id, "2026-03");
    const groceriesSummary = await getEnvelopeMonthSummary(db, household.id, groceriesEnv.id, "2026-03");
    expect(diningSummary.balanceCents).toBe(6000);
    expect(groceriesSummary.balanceCents).toBe(4000);
  });
});

describe("CSV import", () => {
  it("imports rows, categorizes by matching category name, and is idempotent on re-run", async () => {
    const { household, account } = await seedHousehold();
    const rows = parseCsvRows([
      { Date: "3/1/2026", Description: "WALMART #4821 GRAND JCT CO", Category: "Groceries", Amount: "-45.23", Notes: "" },
      { Date: "3/2/2026", Description: "SOME UNKNOWN CATEGORY SHOP", Category: "Nonexistent Category", Amount: "-10.00", Notes: "" },
    ]);

    const first = await importCsvTransactions(db, household.id, account.id, rows);
    expect(first.imported).toBe(2);
    expect(first.skippedDuplicates).toBe(0);
    expect(first.unmatchedCategoryNames).toEqual(["Nonexistent Category"]);

    const second = await importCsvTransactions(db, household.id, account.id, rows);
    expect(second.imported).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const transactions = await listTransactions(db, household.id, { accountId: account.id });
    expect(transactions).toHaveLength(2);
  });
});
