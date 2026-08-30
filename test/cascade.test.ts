import { describe, expect, it } from "vitest";
import { categorize } from "../src/categorization/cascade";
import type { LlmClassifier } from "../src/categorization/llm";
import { UnimplementedLlmClassifier } from "../src/categorization/llm";
import type { CandidateTransaction } from "../src/categorization/types";
import type { MerchantMemory, Rule } from "../src/types";

function makeTxn(overrides: Partial<CandidateTransaction> = {}): CandidateTransaction {
  return {
    id: "txn_test",
    merchant: "COSTCO",
    rawDescription: "COSTCO WHSE #123",
    amountCents: -8000,
    postedAt: "2026-03-10",
    accountType: "credit_card",
    ownerUserId: "usr_nathan",
    ...overrides,
  };
}

function makeRule(conditionsMatchAll: boolean, categoryId: string): Rule {
  return {
    id: "rul_1",
    household_id: "hh_test",
    priority: 10,
    conditions: JSON.stringify(conditionsMatchAll ? { field: "merchant", op: "contains", value: "costco" } : { field: "merchant", op: "contains", value: "nomatch" }),
    actions: JSON.stringify([{ type: "setCategory", categoryId }]),
    source: "user",
    match_count: 0,
    enabled: 1,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
  };
}

class FakeLlmClassifier implements LlmClassifier {
  constructor(private result: { categoryId: string; confidence: number; model?: string } | (() => never)) {}
  async classify() {
    if (typeof this.result === "function") return this.result();
    return { ...this.result, model: this.result.model ?? "claude-haiku-4-5", promptVersion: "v1" };
  }
}

describe("categorize cascade", () => {
  it("layer 1: a matching rule always wins, even over memory", () => {
    const rule = makeRule(true, "cat_household");
    const memory: MerchantMemory = {
      id: "mm_1",
      household_id: "hh_test",
      normalized_merchant: "COSTCO",
      category_id: "cat_groceries",
      hit_count: 10,
      last_confirmed_at: "2026-01-01 00:00:00",
      typical_amount_cents: -8000,
      amount_stddev_cents: 500,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    };
    return categorize(makeTxn(), {
      rules: [rule],
      merchantMemory: memory,
      llm: new UnimplementedLlmClassifier(),
      categories: [],
    }).then((result) => {
      expect(result).toEqual({ layer: "rule", categoryId: "cat_household", ruleId: "rul_1", confidence: 1, needsClarification: false });
    });
  });

  it("layer 2: falls through to merchant memory when no rule matches", async () => {
    const memory: MerchantMemory = {
      id: "mm_1",
      household_id: "hh_test",
      normalized_merchant: "COSTCO",
      category_id: "cat_groceries",
      hit_count: 10,
      last_confirmed_at: "2026-01-01 00:00:00",
      typical_amount_cents: -8000,
      amount_stddev_cents: 500,
      created_at: "2026-01-01 00:00:00",
      updated_at: "2026-01-01 00:00:00",
    };
    const result = await categorize(makeTxn(), {
      rules: [],
      merchantMemory: memory,
      llm: new UnimplementedLlmClassifier(),
      categories: [],
    });
    expect(result.layer).toBe("memory");
    expect(result.needsClarification).toBe(false);
  });

  it("layer 3: falls through to the LLM and auto-applies a confident result", async () => {
    const llm = new FakeLlmClassifier({ categoryId: "cat_groceries", confidence: 0.95 });
    const result = await categorize(makeTxn(), { rules: [], merchantMemory: null, llm, categories: [] });
    expect(result.layer).toBe("llm");
    if (result.layer === "llm") {
      expect(result.categoryId).toBe("cat_groceries");
      // Novel merchant (no memory) needs the higher threshold, but 0.95
      // clears it, and there's no alternatives list to shrink the margin.
      expect(result.needsClarification).toBe(false);
    }
  });

  it("layer 3: a low-confidence LLM result flags for clarification instead of guessing", async () => {
    const llm = new FakeLlmClassifier({ categoryId: "cat_groceries", confidence: 0.4 });
    const result = await categorize(makeTxn(), { rules: [], merchantMemory: null, llm, categories: [] });
    expect(result.layer).toBe("llm");
    if (result.layer === "llm") {
      expect(result.needsClarification).toBe(true);
    }
  });

  it("layer 4: an unavailable LLM never blocks ingest — falls through to 'ask a human'", async () => {
    const result = await categorize(makeTxn(), {
      rules: [],
      merchantMemory: null,
      llm: new UnimplementedLlmClassifier(),
      categories: [],
    });
    expect(result).toEqual({ layer: "none", categoryId: null, needsClarification: true });
  });
});
