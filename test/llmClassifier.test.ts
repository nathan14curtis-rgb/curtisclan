import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { ClaudeLlmClassifier, HAIKU_MODEL, SONNET_MODEL } from "../src/categorization/llm";
import type { CandidateTransaction } from "../src/categorization/types";

function fakeToolUseResponse(model: string, input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "tu_1", name: "categorize_transaction", input }] };
}

function fakeClient(responses: Array<Record<string, unknown>>) {
  const create = vi.fn().mockImplementation(async (params: { model: string }) => {
    const input = responses.shift();
    if (!input) throw new Error("no more fake responses queued");
    return fakeToolUseResponse(params.model, input);
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function txn(overrides: Partial<CandidateTransaction> = {}): CandidateTransaction {
  return {
    id: "txn_1",
    merchant: "COSTCO",
    rawDescription: "COSTCO WHSE #123",
    amountCents: -5000,
    postedAt: "2026-03-10",
    accountType: "credit_card",
    ownerUserId: "usr_1",
    ...overrides,
  };
}

const categories = [
  { id: "cat_groceries", name: "Groceries" },
  { id: "cat_household", name: "Household" },
];

describe("ClaudeLlmClassifier", () => {
  it("returns the Haiku result directly when confident", async () => {
    const { client, create } = fakeClient([
      { category_id: "cat_groceries", confidence: 0.92, reasoning: "warehouse club groceries", alternatives: [] },
    ]);
    const classifier = new ClaudeLlmClassifier(client);
    const result = await classifier.classify({ transaction: txn(), categories, similarPastTransactions: [] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].model).toBe(HAIKU_MODEL);
    expect(result).toMatchObject({ categoryId: "cat_groceries", confidence: 0.92, model: HAIKU_MODEL });
  });

  it("escalates to Sonnet when Haiku is unconfident on a large amount", async () => {
    const { client, create } = fakeClient([
      { category_id: "cat_groceries", confidence: 0.4, reasoning: "unsure", alternatives: [{ category_id: "cat_household", confidence: 0.35 }] },
      { category_id: "cat_household", confidence: 0.85, reasoning: "on review, this is household goods", alternatives: [] },
    ]);
    const classifier = new ClaudeLlmClassifier(client);
    const result = await classifier.classify({
      transaction: txn({ amountCents: -25000 }), // $250, above the default $100 escalation floor
      categories,
      similarPastTransactions: [],
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].model).toBe(SONNET_MODEL);
    expect(result.categoryId).toBe("cat_household");
    expect(result.model).toBe(SONNET_MODEL);
  });

  it("does not escalate an unconfident result on a small amount", async () => {
    const { client, create } = fakeClient([
      { category_id: "cat_groceries", confidence: 0.3, reasoning: "unsure", alternatives: [] },
    ]);
    const classifier = new ClaudeLlmClassifier(client);
    const result = await classifier.classify({ transaction: txn({ amountCents: -500 }), categories, similarPastTransactions: [] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.confidence).toBe(0.3);
  });

  it("maps snake_case tool output to the camelCase result shape", async () => {
    const { client } = fakeClient([
      {
        category_id: "cat_groceries",
        confidence: 0.8,
        reasoning: "r",
        alternatives: [{ category_id: "cat_household", confidence: 0.15 }],
      },
    ]);
    const classifier = new ClaudeLlmClassifier(client);
    const result = await classifier.classify({ transaction: txn(), categories, similarPastTransactions: [] });
    expect(result.alternatives).toEqual([{ categoryId: "cat_household", confidence: 0.15 }]);
    expect(result.promptVersion).toBe("v1");
  });
});
