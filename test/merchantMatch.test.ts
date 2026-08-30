import { describe, expect, it } from "vitest";
import { matchMerchantMemory } from "../src/categorization/merchantMatch";
import type { MerchantMemory } from "../src/types";

function makeMemory(overrides: Partial<MerchantMemory> = {}): MerchantMemory {
  return {
    id: "mm_test",
    household_id: "hh_test",
    normalized_merchant: "BLUE BOTTLE",
    category_id: "cat_coffee",
    hit_count: 5,
    last_confirmed_at: "2026-01-01 00:00:00",
    typical_amount_cents: -600,
    amount_stddev_cents: 100,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("matchMerchantMemory", () => {
  it("returns null when there's no memory at all", () => {
    expect(matchMerchantMemory(null, -600)).toBeNull();
  });

  it("returns null before the merchant has warmed up (< 3 confirmations)", () => {
    expect(matchMerchantMemory(makeMemory({ hit_count: 2 }), -600)).toBeNull();
  });

  it("matches a warm merchant at a typical amount", () => {
    const match = matchMerchantMemory(makeMemory(), -600);
    expect(match?.categoryId).toBe("cat_coffee");
    expect(match?.confidence).toBeGreaterThan(0.7);
    expect(match?.confidence).toBeLessThanOrEqual(0.97);
  });

  it("demotes to the LLM layer when the amount is a wild outlier", () => {
    // Usually a $6 coffee; this "charge" is $600 — not something layer 2
    // should silently trust.
    expect(matchMerchantMemory(makeMemory(), -60000)).toBeNull();
  });

  it("still matches small drift even with zero recorded variance", () => {
    const memory = makeMemory({ hit_count: 3, amount_stddev_cents: 0, typical_amount_cents: -600 });
    expect(matchMerchantMemory(memory, -650)).not.toBeNull();
  });
});
