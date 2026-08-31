/**
 * "Don't trust self-reported confidence alone. Models are overconfident
 * and will claim 0.9 on a genuinely ambiguous charge. Combine it with
 * top-two margin, merchant novelty, amount outlier status, and whether you
 * recently corrected this merchant." (PLAN.md §6)
 *
 * This is deliberately independent of any specific LLM call so it can be
 * unit tested and tuned against the eval set (§6) without needing a live
 * model — Phase 2 wires src/categorization/llm.ts's real output through it.
 */

export interface LlmClassification {
  categoryId: string;
  confidence: number; // model self-reported, 0-1
  alternatives?: Array<{ categoryId: string; confidence: number }>;
}

export interface ConfidenceContext {
  merchantIsNovel: boolean;
  amountIsOutlierForCategory?: boolean;
  recentlyCorrectedThisMerchant?: boolean;
}

export interface ConfidenceThresholds {
  minConfidence: number;
  minTopTwoMargin: number;
  novelMerchantPenalty: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  minConfidence: 0.9,
  minTopTwoMargin: 0.15,
  novelMerchantPenalty: 0.1,
};

/** True => auto-apply the LLM's category with no clarification text. */
export function shouldAutoApply(
  result: LlmClassification,
  ctx: ConfidenceContext,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): boolean {
  // A recent human correction on this exact merchant means the model just
  // got it wrong last time — never let it auto-apply again unsupervised.
  if (ctx.recentlyCorrectedThisMerchant) return false;
  if (ctx.amountIsOutlierForCategory) return false;

  const requiredConfidence = thresholds.minConfidence + (ctx.merchantIsNovel ? thresholds.novelMerchantPenalty : 0);
  if (result.confidence < requiredConfidence) return false;

  const runnerUp = result.alternatives?.[0]?.confidence ?? 0;
  const margin = result.confidence - runnerUp;
  return margin >= thresholds.minTopTwoMargin;
}
