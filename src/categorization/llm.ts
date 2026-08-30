import type { LlmClassification } from "./confidence";
import type { CandidateTransaction } from "./types";

/**
 * Layer 3 of the cascade (PLAN.md §6): Claude Haiku 4.5, escalating to
 * Sonnet 5 on low confidence + large amount. Structured output, taxonomy
 * in a cached prompt prefix, nightly bulk through the Batch API.
 *
 * Not implemented in Phase 0 — this repo doesn't hold an Anthropic API key
 * yet, and wiring a real classifier without one to test against would be
 * unverified code claiming to work. The interface is fixed now so
 * src/categorization/cascade.ts, the confidence combiner, and their tests
 * don't change shape when Phase 2 fills this in.
 */
export interface CategoryOption {
  id: string;
  name: string;
}

export interface SimilarPastTransaction {
  merchant: string;
  amountCents: number;
  categoryId: string;
}

export interface LlmClassifyInput {
  transaction: CandidateTransaction;
  categories: CategoryOption[];
  similarPastTransactions: SimilarPastTransaction[];
}

export interface LlmClassifier {
  classify(input: LlmClassifyInput): Promise<LlmClassification & { model: string; reasoning?: string; promptVersion: string }>;
}

export class UnimplementedLlmClassifier implements LlmClassifier {
  async classify(): Promise<never> {
    throw new Error(
      "LLM categorization layer is not wired up yet (Phase 2, PLAN.md §12) — needs an Anthropic API key in Workers Secrets.",
    );
  }
}
