import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { archiveCategory, listCategories, getDefaultIncomeCategory } from "../src/db/categories";
import { createRule, listRules } from "../src/db/rules";
import { createTransaction, getTransaction, listTransactions } from "../src/db/transactions";
import { getLatestClarificationForTransaction, listOpenClarificationsForHousehold } from "../src/db/clarifications";
import { categorizeTransaction } from "../src/categorization/pipeline";
import { ensureDefaultIncomeRule } from "../src/categorization/defaultIncomeRule";

const db = env.DB;

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, nathan.id, "+13035551234");
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  return { household, checking };
}

describe("getDefaultIncomeCategory", () => {
  it("prefers the seeded 'Other Income' category", async () => {
    const { household } = await seedHousehold();
    const category = await getDefaultIncomeCategory(db, household.id);
    expect(category?.name).toBe("Other Income");
  });

  it("falls back to any income-kind category if 'Other Income' is archived", async () => {
    const { household } = await seedHousehold();
    const otherIncome = (await listCategories(db, household.id)).find((c) => c.name === "Other Income")!;
    await archiveCategory(db, household.id, otherIncome.id);

    const category = await getDefaultIncomeCategory(db, household.id);
    expect(category?.name).toBe("Paycheck");
  });

  it("returns null when the household has no income category at all", async () => {
    const { household } = await seedHousehold();
    for (const c of await listCategories(db, household.id)) {
      if (c.kind === "income") await archiveCategory(db, household.id, c.id);
    }
    expect(await getDefaultIncomeCategory(db, household.id)).toBeNull();
  });
});

describe("ensureDefaultIncomeRule", () => {
  it("creates a low-priority amount>0 rule pointing at the default income category", async () => {
    const { household } = await seedHousehold();
    const otherIncome = (await listCategories(db, household.id)).find((c) => c.name === "Other Income")!;

    const rule = await ensureDefaultIncomeRule(db, household.id);

    expect(rule).not.toBeNull();
    expect(JSON.parse(rule!.conditions)).toEqual({ field: "amount", op: "gt", value: 0 });
    expect(JSON.parse(rule!.actions)).toEqual([{ type: "setCategory", categoryId: otherIncome.id }]);
  });

  it("is idempotent — a second call doesn't create a duplicate rule", async () => {
    const { household } = await seedHousehold();
    const first = await ensureDefaultIncomeRule(db, household.id);
    const second = await ensureDefaultIncomeRule(db, household.id);

    expect(second!.id).toBe(first!.id);
    const rules = await listRules(db, household.id);
    expect(rules).toHaveLength(1);
  });

  it("returns null and creates nothing when there's no income category to point at", async () => {
    const { household } = await seedHousehold();
    for (const c of await listCategories(db, household.id)) {
      if (c.kind === "income") await archiveCategory(db, household.id, c.id);
    }

    expect(await ensureDefaultIncomeRule(db, household.id)).toBeNull();
    expect(await listRules(db, household.id)).toHaveLength(0);
  });
});

describe("categorizeTransaction with the default income rule seeded", () => {
  it("auto-files a paycheck-shaped deposit with no clarification, no LLM call", async () => {
    const { household, checking } = await seedHousehold();
    await ensureDefaultIncomeRule(db, household.id);
    const otherIncome = (await listCategories(db, household.id)).find((c) => c.name === "Other Income")!;

    const deposit = await createTransaction(db, household.id, {
      accountId: checking.id,
      postedAt: "2026-03-10",
      amountCents: 471000,
      rawDescription: "PAYCHECK NORTHWIND INC",
      normalizedMerchant: "NORTHWIND INC",
    });

    // No ANTHROPIC_API_KEY set in this test env — if this fell through to
    // the LLM layer (the old, unfixed behavior for a deposit), the cascade
    // would log an LLM failure and ask a human instead of applying a
    // category. The rule layer must resolve it first.
    await categorizeTransaction(env, household.id, deposit.id);

    const updated = await getTransaction(db, household.id, deposit.id);
    expect(updated.category_id).toBe(otherIncome.id);
    expect(await listOpenClarificationsForHousehold(db, household.id)).toHaveLength(0);
  });

  it("still lets a more specific household rule win over the default", async () => {
    const { household, checking } = await seedHousehold();
    await ensureDefaultIncomeRule(db, household.id);
    const paycheck = (await listCategories(db, household.id)).find((c) => c.name === "Paycheck")!;
    await createRule(db, household.id, {
      priority: 10, // lower number = higher priority — must beat the default's 900
      conditions: { field: "merchant", op: "contains", value: "northwind" },
      actions: [{ type: "setCategory", categoryId: paycheck.id }],
    });

    const deposit = await createTransaction(db, household.id, {
      accountId: checking.id,
      postedAt: "2026-03-10",
      amountCents: 471000,
      rawDescription: "PAYCHECK NORTHWIND INC",
      normalizedMerchant: "NORTHWIND INC",
    });
    await categorizeTransaction(env, household.id, deposit.id);

    const updated = await getTransaction(db, household.id, deposit.id);
    expect(updated.category_id).toBe(paycheck.id);
  });

  it("does not touch a negative-amount (expense) transaction", async () => {
    const { household, checking } = await seedHousehold();
    await ensureDefaultIncomeRule(db, household.id);

    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4500, rawDescription: "SOME STORE",
    });
    await categorizeTransaction(env, household.id, txn.id);

    // No LLM key configured and nothing else matches — falls through to
    // "ask a human," unaffected by the income rule.
    const clarification = await getLatestClarificationForTransaction(db, household.id, txn.id);
    expect(clarification?.status).toBe("queued");
    const unchanged = await getTransaction(db, household.id, txn.id);
    expect(unchanged.category_id).toBeNull();
    expect(await listTransactions(db, household.id, { accountId: checking.id })).toHaveLength(1);
  });
});
