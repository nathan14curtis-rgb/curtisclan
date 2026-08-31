import { describe, expect, it } from "vitest";
import { shouldAutoApply } from "../src/categorization/confidence";

describe("shouldAutoApply", () => {
  it("auto-applies a high-confidence, well-separated known merchant", () => {
    const result = shouldAutoApply(
      { categoryId: "cat_groceries", confidence: 0.95, alternatives: [{ categoryId: "cat_household", confidence: 0.2 }] },
      { merchantIsNovel: false },
    );
    expect(result).toBe(true);
  });

  it("does not trust a bare self-reported confidence with no margin (PLAN.md §6)", () => {
    // The model claims 0.9 but its runner-up is nearly as confident —
    // exactly the "genuinely ambiguous charge" the plan calls out.
    const result = shouldAutoApply(
      { categoryId: "cat_dining", confidence: 0.9, alternatives: [{ categoryId: "cat_groceries", confidence: 0.85 }] },
      { merchantIsNovel: false },
    );
    expect(result).toBe(false);
  });

  it("requires extra confidence for a novel merchant", () => {
    const borderline = { categoryId: "cat_dining", confidence: 0.93, alternatives: [{ categoryId: "cat_other", confidence: 0.1 }] };
    expect(shouldAutoApply(borderline, { merchantIsNovel: false })).toBe(true);
    expect(shouldAutoApply(borderline, { merchantIsNovel: true })).toBe(false);
  });

  it("never auto-applies right after a human correction on this merchant", () => {
    const result = shouldAutoApply(
      { categoryId: "cat_dining", confidence: 0.99, alternatives: [] },
      { merchantIsNovel: false, recentlyCorrectedThisMerchant: true },
    );
    expect(result).toBe(false);
  });

  it("never auto-applies when the amount is an outlier for the category", () => {
    const result = shouldAutoApply(
      { categoryId: "cat_dining", confidence: 0.99, alternatives: [] },
      { merchantIsNovel: false, amountIsOutlierForCategory: true },
    );
    expect(result).toBe(false);
  });

  it("treats a missing alternatives list as an unopposed top-1 (full margin)", () => {
    const result = shouldAutoApply({ categoryId: "cat_dining", confidence: 0.9 }, { merchantIsNovel: false });
    expect(result).toBe(true);
  });
});
