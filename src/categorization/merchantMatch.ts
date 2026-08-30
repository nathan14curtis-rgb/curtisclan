import type { MerchantMemory } from "../types";

const MIN_HIT_COUNT = 3;
const MIN_OUTLIER_BAND_CENTS = 500; // even a $0 stddev merchant tolerates a few dollars of drift
const OUTLIER_STDDEV_MULTIPLE = 3;

export interface MerchantMatch {
  categoryId: string;
  confidence: number;
}

/**
 * Layer 2 of the cascade (PLAN.md §6): a merchant seen enough times with a
 * consistent, human-confirmed category is trusted without a model call.
 * Guarded on both sides — too few confirmations, or an amount well outside
 * what's typical for this merchant — either of which demotes to the LLM
 * layer instead of trusting a stale or mismatched memory.
 */
export function matchMerchantMemory(memory: MerchantMemory | null, amountCents: number): MerchantMatch | null {
  if (!memory || memory.hit_count < MIN_HIT_COUNT) return null;

  const typical = memory.typical_amount_cents ?? amountCents;
  const band = Math.max((memory.amount_stddev_cents ?? 0) * OUTLIER_STDDEV_MULTIPLE, MIN_OUTLIER_BAND_CENTS);
  if (Math.abs(amountCents - typical) > band) return null;

  // Confidence rises with confirmations but never claims certainty a
  // repeated LLM guess wouldn't also earn — caps below 1.0 (reserved for
  // deterministic rule matches).
  const confidence = Math.min(0.7 + memory.hit_count * 0.02, 0.97);
  return { categoryId: memory.category_id, confidence };
}
