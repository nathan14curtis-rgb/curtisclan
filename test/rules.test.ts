import { describe, expect, it } from "vitest";
import { categoryFromRule, findMatchingRule, ruleMatches, type Action, type Condition } from "../src/categorization/rules";
import type { CandidateTransaction } from "../src/categorization/types";
import type { Rule } from "../src/types";

function makeRule(overrides: Omit<Partial<Rule>, "conditions" | "actions"> & { conditions: Condition; actions: Action[] }): Rule {
  return {
    id: overrides.id ?? "rul_test",
    household_id: "hh_test",
    priority: overrides.priority ?? 100,
    conditions: JSON.stringify(overrides.conditions),
    actions: JSON.stringify(overrides.actions),
    source: "user",
    match_count: 0,
    enabled: overrides.enabled ?? 1,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
  };
}

function makeTxn(overrides: Partial<CandidateTransaction> = {}): CandidateTransaction {
  return {
    id: "txn_test",
    merchant: "STARBUCKS",
    rawDescription: "STARBUCKS #1234 DENVER CO",
    amountCents: -550,
    postedAt: "2026-03-10", // a Tuesday
    accountType: "credit_card",
    ownerUserId: "usr_nathan",
    ...overrides,
  };
}

describe("ruleMatches", () => {
  it("matches a merchant contains condition", () => {
    const rule = makeRule({
      conditions: { field: "merchant", op: "contains", value: "starbucks" },
      actions: [{ type: "setCategory", categoryId: "cat_coffee" }],
    });
    expect(ruleMatches(rule, makeTxn())).toBe(true);
    expect(ruleMatches(rule, makeTxn({ merchant: "WALMART" }))).toBe(false);
  });

  it("matches amount ranges", () => {
    const rule = makeRule({
      conditions: { field: "amount", op: "between", value: [-1000, -100] },
      actions: [{ type: "setCategory", categoryId: "cat_coffee" }],
    });
    expect(ruleMatches(rule, makeTxn({ amountCents: -550 }))).toBe(true);
    expect(ruleMatches(rule, makeTxn({ amountCents: -5000 }))).toBe(false);
  });

  it("combines conditions with and/or", () => {
    const rule = makeRule({
      conditions: {
        type: "and",
        conditions: [
          { field: "merchant", op: "contains", value: "starbucks" },
          { field: "amount", op: "lt", value: 0 },
        ],
      },
      actions: [{ type: "setCategory", categoryId: "cat_coffee" }],
    });
    expect(ruleMatches(rule, makeTxn())).toBe(true);
    expect(ruleMatches(rule, makeTxn({ amountCents: 550 }))).toBe(false);
  });

  it("never matches a disabled rule", () => {
    const rule = makeRule({
      enabled: 0,
      conditions: { field: "merchant", op: "contains", value: "starbucks" },
      actions: [{ type: "setCategory", categoryId: "cat_coffee" }],
    });
    expect(ruleMatches(rule, makeTxn())).toBe(false);
  });
});

describe("findMatchingRule", () => {
  it("picks the lowest-priority-number match, not declaration order", () => {
    const low = makeRule({
      id: "rul_low",
      priority: 50,
      conditions: { field: "merchant", op: "contains", value: "starbucks" },
      actions: [{ type: "setCategory", categoryId: "cat_coffee" }],
    });
    const high = makeRule({
      id: "rul_high",
      priority: 10,
      conditions: { field: "merchant", op: "contains", value: "starbucks" },
      actions: [{ type: "setCategory", categoryId: "cat_other" }],
    });
    const match = findMatchingRule([low, high], makeTxn());
    expect(match?.id).toBe("rul_high");
    expect(categoryFromRule(match!)).toBe("cat_other");
  });

  it("returns null when nothing matches", () => {
    const rule = makeRule({
      conditions: { field: "merchant", op: "contains", value: "costco" },
      actions: [{ type: "setCategory", categoryId: "cat_household" }],
    });
    expect(findMatchingRule([rule], makeTxn())).toBeNull();
  });
});
