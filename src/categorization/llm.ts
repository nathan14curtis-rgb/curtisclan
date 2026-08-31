import Anthropic from "@anthropic-ai/sdk";
import type { LlmClassification } from "./confidence";
import type { CandidateTransaction } from "./types";

/** Layer 3 of the cascade (PLAN.md §6): Claude Haiku 4.5, escalating to
 * Sonnet 5 on low confidence + a large amount. Structured output via a
 * forced strict tool call, taxonomy in a cached prompt-prefix. */

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

export type LlmClassifyResult = LlmClassification & { model: string; reasoning?: string; promptVersion: string };

export interface LlmClassifier {
  classify(input: LlmClassifyInput): Promise<LlmClassifyResult>;
}

/** Phase-0/1 default when no Anthropic key is configured, and what the
 * existing cascade tests exercise for the "LLM unavailable" fallback path. */
export class UnimplementedLlmClassifier implements LlmClassifier {
  async classify(): Promise<never> {
    throw new Error(
      "LLM categorization layer is not configured — set ANTHROPIC_API_KEY (wrangler secret put ANTHROPIC_API_KEY).",
    );
  }
}

export const PROMPT_VERSION = "v1";
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
export const SONNET_MODEL = "claude-sonnet-5";
const TOOL_NAME = "categorize_transaction";

function buildTool(categories: CategoryOption[]): Anthropic.Tool {
  const categoryIds = categories.map((c) => c.id);
  return {
    name: TOOL_NAME,
    description: "Categorize a household bank/credit-card transaction into exactly one of the given budget categories.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        category_id: { type: "string", enum: categoryIds },
        // Anthropic's strict/custom tool schemas only support a narrow
        // JSON Schema subset — no numeric/array constraint keywords like
        // minimum/maximum/maxItems, all rejected with a 400. The [0, 1]
        // confidence range and "up to 3 alternatives" are enforced by the
        // prompt instructions instead (buildSystemPrompt below).
        confidence: { type: "number" },
        reasoning: { type: "string" },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category_id: { type: "string", enum: categoryIds },
              confidence: { type: "number" },
            },
            required: ["category_id", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["category_id", "confidence", "reasoning", "alternatives"],
      additionalProperties: false,
    },
  };
}

/** Static per household (the taxonomy), so this is exactly what
 * cache_control should cover — everything volatile (the transaction
 * itself) goes in the user message instead (PLAN.md §6). */
function buildSystemPrompt(categories: CategoryOption[]): string {
  const taxonomy = categories.map((c) => `- ${c.id}: ${c.name}`).join("\n");
  return [
    "You are a transaction categorization assistant for a household budgeting app.",
    "Given one bank or credit card transaction, pick the single best-fitting category from this list — never invent a category_id that isn't in it:",
    taxonomy,
    "",
    "Rules:",
    "- confidence is your genuine belief this category is correct (0 to 1). Do not default to a high number — a genuinely ambiguous charge should get a low confidence and close alternatives, not false certainty.",
    "- alternatives lists up to 3 other plausible categories with their own confidence, most likely first. An empty list means no real alternative exists.",
    "- reasoning is one short sentence: what about the merchant, amount, or description drove the pick.",
    "- If similar past transactions for this household are given, they show how this exact household has categorized similar merchants before. Weight them heavily — a merchant this household has already confirmed should usually get the same category again, unless this new transaction looks meaningfully different (e.g. a much larger amount, a different kind of purchase at the same store).",
  ].join("\n");
}

/** Deliberately narrow — this is what leaves the app boundary (PLAN.md
 * §10): merchant, description, amount, date, account type, and the
 * household's own past categorizations. No account numbers, no balances,
 * no names. */
function buildUserMessage(input: LlmClassifyInput): string {
  const t = input.transaction;
  const dollars = (Math.abs(t.amountCents) / 100).toFixed(2);
  const direction = t.amountCents < 0 ? "charge" : "credit/refund";
  const similar = input.similarPastTransactions.length
    ? input.similarPastTransactions.map((s) => `- ${s.merchant}: $${(Math.abs(s.amountCents) / 100).toFixed(2)} -> ${s.categoryId}`).join("\n")
    : "(none)";

  return [
    "Transaction to categorize:",
    `merchant: ${t.merchant ?? "(unknown)"}`,
    `description: ${t.rawDescription}`,
    `amount: $${dollars} (${direction})`,
    `date: ${t.postedAt}`,
    `account type: ${t.accountType}`,
    "",
    "Similar past transactions for this household:",
    similar,
  ].join("\n");
}

interface ToolInput {
  category_id: string;
  confidence: number;
  reasoning: string;
  alternatives: Array<{ category_id: string; confidence: number }>;
}

function parseToolResult(content: Anthropic.ContentBlock[], model: string): LlmClassifyResult {
  const toolUse = content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) throw new Error(`Claude did not return a ${TOOL_NAME} tool call despite a forced tool_choice`);
  const parsed = toolUse.input as ToolInput;
  return {
    categoryId: parsed.category_id,
    confidence: parsed.confidence,
    alternatives: parsed.alternatives.map((a) => ({ categoryId: a.category_id, confidence: a.confidence })),
    model,
    reasoning: parsed.reasoning,
    promptVersion: PROMPT_VERSION,
  };
}

export interface ClaudeClassifierOptions {
  /** Escalate to Sonnet only when Haiku's confidence is below this *and*
   * the amount clears the floor below — "one better model call is
   * cheaper than an unnecessary interruption" (PLAN.md §6), but not worth
   * spending on a $4 coffee. */
  escalateBelowConfidence?: number;
  escalateAboveAmountCents?: number;
}

const DEFAULT_ESCALATE_BELOW_CONFIDENCE = 0.7;
const DEFAULT_ESCALATE_ABOVE_AMOUNT_CENTS = 10_000; // $100

export class ClaudeLlmClassifier implements LlmClassifier {
  constructor(private readonly client: Anthropic, private readonly options: ClaudeClassifierOptions = {}) {}

  async classify(input: LlmClassifyInput): Promise<LlmClassifyResult> {
    const primary = await this.callModel(HAIKU_MODEL, input);

    const confidenceFloor = this.options.escalateBelowConfidence ?? DEFAULT_ESCALATE_BELOW_CONFIDENCE;
    const amountFloor = this.options.escalateAboveAmountCents ?? DEFAULT_ESCALATE_ABOVE_AMOUNT_CENTS;
    const shouldEscalate = primary.confidence < confidenceFloor && Math.abs(input.transaction.amountCents) >= amountFloor;
    if (!shouldEscalate) return primary;

    return this.callModel(SONNET_MODEL, input);
  }

  private async callModel(model: string, input: LlmClassifyInput): Promise<LlmClassifyResult> {
    const response = await this.client.messages.create({
      model,
      max_tokens: 1024,
      system: [{ type: "text", text: buildSystemPrompt(input.categories), cache_control: { type: "ephemeral" } }],
      tools: [buildTool(input.categories)],
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages: [{ role: "user", content: buildUserMessage(input) }],
    });
    return parseToolResult(response.content, model);
  }
}

/**
 * Nightly/backfill bulk path at half price (PLAN.md §6, §12 Phase 2:
 * "batch backfill through Queues"). Submission only — polling and
 * applying results is the backfill job's responsibility, since it needs
 * to track batch ids across cron ticks; these two helpers are the reusable
 * pieces once that job exists.
 */
export async function submitCategorizationBatch(
  client: Anthropic,
  requests: Array<{ customId: string; input: LlmClassifyInput }>,
): Promise<string> {
  const batch = await client.messages.batches.create({
    requests: requests.map(({ customId, input }) => ({
      custom_id: customId,
      params: {
        model: HAIKU_MODEL,
        max_tokens: 1024,
        system: [{ type: "text", text: buildSystemPrompt(input.categories), cache_control: { type: "ephemeral" } }],
        tools: [buildTool(input.categories)],
        tool_choice: { type: "tool", name: TOOL_NAME },
        messages: [{ role: "user", content: buildUserMessage(input) }],
      },
    })),
  });
  return batch.id;
}

export async function retrieveCategorizationBatch(client: Anthropic, batchId: string) {
  return client.messages.batches.retrieve(batchId);
}

export async function parseCategorizationBatchResults(
  client: Anthropic,
  batchId: string,
): Promise<Map<string, LlmClassifyResult>> {
  const results = new Map<string, LlmClassifyResult>();
  for await (const result of await client.messages.batches.results(batchId)) {
    if (result.result.type !== "succeeded") continue;
    results.set(result.custom_id, parseToolResult(result.result.message.content, result.result.message.model));
  }
  return results;
}
