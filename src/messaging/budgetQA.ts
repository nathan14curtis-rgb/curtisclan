import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL } from "../categorization/llm";
import { listCategories } from "../db/categories";
import { getEnvelopeMonthSummariesForHousehold, listEnvelopes } from "../db/envelopes";
import type { Env } from "../types";

/**
 * Conversational Q&A for plain-text replies that aren't about categorizing
 * a charge ("how much left on groceries?", "are we over on dining?").
 * Deliberately plain-text output, not a tool call — this is the one path
 * where the answer itself, not a structured pairing, is the product.
 * Kept to one cheap Haiku call with a short, capped response to hold
 * down cost per PLAN.md-style token discipline.
 */

const MAX_ANSWER_TOKENS = 200;

function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(0)}`;
}

async function buildBudgetSnapshot(env: Env, householdId: string): Promise<string> {
  const month = new Date().toISOString().slice(0, 7);
  const [envelopes, categories, summaries] = await Promise.all([
    listEnvelopes(env.DB, householdId),
    listCategories(env.DB, householdId),
    getEnvelopeMonthSummariesForHousehold(env.DB, householdId, month),
  ]);
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  const lines = envelopes
    .filter((e) => !e.archived_at)
    .map((e) => {
      const s = summaries[e.id];
      const name = categoryNameById.get(e.category_id) ?? "?";
      if (!s) return `- ${name}: no data`;
      return `- ${name}: spent ${formatDollars(s.spentCents)} this month, balance ${formatDollars(s.balanceCents)}`;
    });

  return [`Budget snapshot for ${month}:`, ...lines].join("\n");
}

/** Answers a free-text budget question. Returns null if there's genuinely
 * nothing to say (no envelopes yet) — caller decides the fallback text. */
export async function answerBudgetQuestion(env: Env, householdId: string, question: string, anthropicClient?: Anthropic): Promise<string | null> {
  if (!env.ANTHROPIC_API_KEY) return null;
  const snapshot = await buildBudgetSnapshot(env, householdId);

  const client = anthropicClient ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: MAX_ANSWER_TOKENS,
    system: [
      {
        type: "text",
        text: "You text back short, direct answers to budget questions for a household budgeting app. One or two sentences, plain text, no markdown, no preamble. Use only the numbers given — never invent figures. If the snapshot doesn't answer the question, say so plainly.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: `${snapshot}\n\nQuestion: "${question}"` }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return textBlock?.text.trim() || null;
}
