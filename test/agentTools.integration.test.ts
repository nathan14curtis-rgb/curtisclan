import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { allocateToEnvelope, getEnvelopeMonthSummary, listEnvelopes } from "../src/db/envelopes";
import { listRules } from "../src/db/rules";
import { applyCategorization, createTransaction, getTransaction } from "../src/db/transactions";
import { createClarification, getClarification } from "../src/db/clarifications";
import { runAgentTool, type AgentToolContext } from "../src/messaging/agentTools";

const db = env.DB;

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  const ctx: AgentToolContext = { householdId: household.id, userId: nathan.id };
  return { household, nathan, checking, ctx };
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

const month = new Date().toISOString().slice(0, 7);

describe("runAgentTool — writes go through the same paths the dashboard uses", () => {
  it("categorizes a charge, closes its open question, and teaches the merchant", async () => {
    const { household, nathan, checking, ctx } = await seed();
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-04`, amountCents: -4783, rawDescription: "THE HIVE MERCANTILE", normalizedMerchant: "THE HIVE MERCANTILE",
    });
    const clarification = await createClarification(db, household.id, { transactionId: txn.id, userId: nathan.id, questionText: "What was this?" });

    const outcome = await runAgentTool(env, ctx, "categorize_transactions", {
      items: [{ transaction_id: txn.id, category: "groceries", memo: "party supplies" }],
    });

    expect(outcome.isError).toBe(false);
    const updated = await getTransaction(db, household.id, txn.id);
    expect(updated.category_id).toBe(groceries.id);
    expect(updated.memo).toBe("party supplies");
    expect((await getClarification(db, household.id, clarification.id)).status).toBe("answered");

    // method='human' with the texter's id — the same reinforcement a
    // dashboard edit produces, so the merchant is learned either way.
    const memory = await db
      .prepare(`SELECT * FROM merchant_memory WHERE household_id = ? AND normalized_merchant = ?`)
      .bind(household.id, "THE HIVE MERCANTILE")
      .first<{ category_id: string; hit_count: number }>();
    expect(memory?.category_id).toBe(groceries.id);
    const classification = await db
      .prepare(`SELECT * FROM transaction_classification WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(txn.id)
      .first<{ method: string; created_by_user_id: string }>();
    expect(classification?.method).toBe("human");
    expect(classification?.created_by_user_id).toBe(nathan.id);
  });

  it("retargets an envelope and turns one into a dated goal", async () => {
    const { household, ctx } = await seed();
    const outcome = await runAgentTool(env, ctx, "update_spending_plan", {
      category: "Groceries",
      monthly_target_dollars: 900,
      group: "Everyday",
    });

    expect(parse(outcome.content).monthly_target_dollars).toBe(900);
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    const envelope = (await listEnvelopes(db, household.id)).find((e) => e.category_id === groceries.id)!;
    expect(envelope.monthly_target_cents).toBe(90000);
    expect(envelope.group_name).toBe("Everyday");

    await runAgentTool(env, ctx, "create_category", {
      name: "Disney Trip",
      kind: "savings",
      group: "Goals",
      monthly_target_dollars: 400,
      goal_date: "2027-06-01",
    });
    const disney = (await listCategories(db, household.id)).find((c) => c.name === "Disney Trip")!;
    const disneyEnvelope = (await listEnvelopes(db, household.id)).find((e) => e.category_id === disney.id)!;
    expect(disneyEnvelope.monthly_target_cents).toBe(40000);
    expect(disneyEnvelope.target_date).toBe("2027-06-01");
  });

  it("moves money between envelopes as a reversible pair of ledger entries", async () => {
    const { household, ctx } = await seed();
    const categories = await listCategories(db, household.id);
    const envelopes = await listEnvelopes(db, household.id);
    const dining = envelopes.find((e) => e.category_id === categories.find((c) => c.name === "Dining Out")!.id)!;
    const gas = envelopes.find((e) => e.category_id === categories.find((c) => c.name === "Gas")!.id)!;
    await allocateToEnvelope(db, household.id, { envelopeId: dining.id, month, amountCents: 20000 });

    const outcome = await runAgentTool(env, ctx, "move_money", {
      from_category: "Dining Out",
      to_category: "Gas",
      amount_dollars: 50,
      note: "road trip",
    });

    expect(outcome.isError).toBe(false);
    expect((await getEnvelopeMonthSummary(db, household.id, dining.id, month)).balanceCents).toBe(15000);
    expect((await getEnvelopeMonthSummary(db, household.id, gas.id, month)).balanceCents).toBe(5000);
  });

  it("writes a standing merchant rule only when asked for one", async () => {
    const { household, ctx } = await seed();
    await runAgentTool(env, ctx, "always_categorize_merchant", { merchant_contains: "MAVERIK", category: "Gas" });

    const rules = await listRules(db, household.id);
    const created = rules.find((r) => r.conditions.includes("MAVERIK"))!;
    expect(JSON.parse(created.conditions)).toEqual({ field: "merchant", op: "contains", value: "MAVERIK" });
    expect(created.source).toBe("user");
  });

  it("reports what actually happened instead of guessing when an argument is wrong", async () => {
    const { ctx } = await seed();

    const unknownCategory = await runAgentTool(env, ctx, "categorize_transactions", {
      items: [{ transaction_id: "txn_nope", category: "Yacht Maintenance" }],
    });
    expect(unknownCategory.isError).toBe(true);
    expect(unknownCategory.content).toContain("No category named 'Yacht Maintenance'");
    expect(unknownCategory.content).toContain("Groceries"); // the real list, so the retry can be right

    const incomeEnvelope = await runAgentTool(env, ctx, "move_money", {
      from_category: "Paycheck",
      to_category: "Gas",
      amount_dollars: 10,
    });
    expect(incomeEnvelope.isError).toBe(true);
    expect(incomeEnvelope.content).toContain("has no envelope");

    const missingTransaction = await runAgentTool(env, ctx, "set_transaction_excluded", { transaction_id: "txn_nope", excluded: true });
    expect(missingTransaction.isError).toBe(true);

    const unknownTool = await runAgentTool(env, ctx, "delete_everything", {});
    expect(unknownTool.isError).toBe(true);
  });

  it("reads a household's own data only", async () => {
    const { ctx, household, checking } = await seed();
    const other = await createHousehold(db, { name: "Someone Else" });
    const otherAccount = await createAccount(db, other.id, { name: "Their Checking", type: "depository_checking" });
    const theirs = await createTransaction(db, other.id, {
      accountId: otherAccount.id, postedAt: `${month}-02`, amountCents: -9900, rawDescription: "THEIR SECRET SPLURGE",
    });
    await applyCategorization(db, other.id, theirs.id, {
      categoryId: (await listCategories(db, other.id)).find((c) => c.name === "Groceries")!.id,
      method: "llm",
    });
    const ours = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-02`, amountCents: -1100, rawDescription: "OUR COFFEE",
    });

    const outcome = await runAgentTool(env, ctx, "search_transactions", { from_date: `${month}-01` });
    const found = parse(outcome.content).transactions as Array<{ transaction_id: string }>;
    expect(found.map((t) => t.transaction_id)).toEqual([ours.id]);
  });
});
