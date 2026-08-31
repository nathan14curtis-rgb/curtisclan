import { describeError } from "../lib/errors";
import type { MerchantMemory, Rule } from "../types";
import { DEFAULT_CONFIDENCE_THRESHOLDS, shouldAutoApply, type ConfidenceThresholds } from "./confidence";
import type { CategoryOption, LlmClassifier, SimilarPastTransaction } from "./llm";
import { matchMerchantMemory } from "./merchantMatch";
import { categoryFromRule, findMatchingRule } from "./rules";
import type { CandidateTransaction, CascadeResult } from "./types";

export interface CascadeContext {
  rules: Rule[];
  merchantMemory: MerchantMemory | null;
  llm: LlmClassifier;
  categories: CategoryOption[];
  similarPastTransactions?: SimilarPastTransaction[];
  /** A human corrected this exact merchant recently enough that the LLM
   * should not be trusted to auto-apply unsupervised (PLAN.md §6). */
  recentlyCorrectedThisMerchant?: boolean;
  amountIsOutlierForCategory?: boolean;
  confidenceThresholds?: ConfidenceThresholds;
}

/**
 * Four layers, first match wins (PLAN.md §6): user rules, then merchant
 * memory, then the LLM, then — implicitly, via needsClarification — a
 * human over iMessage. This function never sends every transaction to the
 * LLM; it only reaches layer 3 once layers 1-2 have nothing.
 */
export async function categorize(txn: CandidateTransaction, ctx: CascadeContext): Promise<CascadeResult> {
  const rule = findMatchingRule(ctx.rules, txn);
  if (rule) {
    const categoryId = categoryFromRule(rule);
    if (categoryId) {
      return { layer: "rule", categoryId, ruleId: rule.id, confidence: 1, needsClarification: false };
    }
  }

  const memoryMatch = matchMerchantMemory(ctx.merchantMemory, txn.amountCents);
  if (memoryMatch) {
    return { layer: "memory", categoryId: memoryMatch.categoryId, confidence: memoryMatch.confidence, needsClarification: false };
  }

  try {
    const llmResult = await ctx.llm.classify({
      transaction: txn,
      categories: ctx.categories,
      similarPastTransactions: ctx.similarPastTransactions ?? [],
    });

    const autoApply = shouldAutoApply(
      llmResult,
      {
        merchantIsNovel: ctx.merchantMemory === null,
        amountIsOutlierForCategory: ctx.amountIsOutlierForCategory,
        recentlyCorrectedThisMerchant: ctx.recentlyCorrectedThisMerchant,
      },
      ctx.confidenceThresholds ?? DEFAULT_CONFIDENCE_THRESHOLDS,
    );

    return {
      layer: "llm",
      categoryId: llmResult.categoryId,
      confidence: llmResult.confidence,
      model: llmResult.model,
      reasoning: llmResult.reasoning,
      promptVersion: llmResult.promptVersion,
      needsClarification: !autoApply,
    };
  } catch (err) {
    // LLM layer unavailable or errored — never block ingest on it. Falls
    // through to "ask a human" with no guess yet; the caller (Phase 3's
    // queue consumer) is responsible for §5.5's "always assign a best
    // guess immediately" once a layer actually produces one. Logged
    // (rather than swallowed outright) so a broken LLM layer is visible
    // in Workers Logs instead of silently degrading forever.
    console.error(`[cascade] LLM layer failed for ${txn.id}: ${describeError(err)}`);
    return { layer: "none", categoryId: null, needsClarification: true };
  }
}
