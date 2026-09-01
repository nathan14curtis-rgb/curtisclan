import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL } from "./llm";

/**
 * "AI automatically creates all my categories for me" (propose, then a
 * person approves — never silently creates anything). One Haiku call over
 * an aggregated, privacy-safe merchant summary (counts and average
 * amounts, never individual transactions or account details, matching the
 * same boundary as src/categorization/llm.ts) plus the household's
 * existing category names, so it proposes new categories/envelopes for
 * spending that isn't well covered yet instead of duplicating "Groceries."
 */

export interface MerchantSummary {
  merchant: string;
  count: number;
  avgAmountCents: number;
  kind: "expense" | "income";
}

export interface ExistingCategorySummary {
  name: string;
  kind: string;
}

export interface CategorySuggestion {
  name: string;
  kind: "expense" | "income" | "savings";
  groupName: string;
  monthlyTargetCents: number | null;
  reasoning: string;
}

const TOOL_NAME = "suggest_categories";

function buildTool() {
  return {
    name: TOOL_NAME,
    description: "Propose new budget categories/envelopes based on a household's actual spending, without duplicating categories it already has.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string", enum: ["expense", "income", "savings"] },
              group_name: { type: "string", description: "A short group label, e.g. 'Housing' or 'Kids'." },
              monthly_target_cents: { type: "integer", description: "A reasonable monthly budget in cents based on the merchant data given, or 0 if none applies (income/savings)." },
              reasoning: { type: "string", description: "One short sentence: what merchant activity justifies this category." },
            },
            required: ["name", "kind", "group_name", "monthly_target_cents", "reasoning"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  };
}

function buildSystemPrompt(): string {
  return [
    "You suggest new budget categories for a household budgeting app, based on their actual merchant activity.",
    "Rules:",
    "- Never propose a category whose name duplicates or is a close synonym of one the household already has — the existing list is the household's real taxonomy, treat it as authoritative.",
    "- Only propose a category when the merchant summary shows real, recurring activity that doesn't fit any existing category well.",
    "- monthly_target_cents should be a sensible round-number budget based on the average amount and frequency given — 0 only for income or savings categories with no natural monthly target.",
    "- Propose at most 8 categories. An empty list is the right answer if the existing taxonomy already covers everything.",
    "- kind: 'expense' for spending, 'income' for money in, 'savings' for a goal to set aside money toward (only when the data suggests an actual savings pattern, not spending).",
  ].join("\n");
}

function buildUserMessage(existing: ExistingCategorySummary[], merchants: MerchantSummary[]): string {
  const existingList = existing.map((c) => `- ${c.name} (${c.kind})`).join("\n") || "(none yet)";
  const merchantList = merchants
    .map((m) => `- ${m.merchant}: ${m.count}x, avg $${(Math.abs(m.avgAmountCents) / 100).toFixed(2)} (${m.kind})`)
    .join("\n");
  return [
    "Existing categories:",
    existingList,
    "",
    "Merchant activity (uncategorized or worth reconsidering):",
    merchantList || "(none)",
  ].join("\n");
}

interface ToolInput {
  suggestions: Array<{ name: string; kind: "expense" | "income" | "savings"; group_name: string; monthly_target_cents: number; reasoning: string }>;
}

export async function suggestCategories(
  client: Anthropic,
  existing: ExistingCategorySummary[],
  merchants: MerchantSummary[],
): Promise<CategorySuggestion[]> {
  if (merchants.length === 0) return [];

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    system: [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }],
    tools: [buildTool()],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(existing, merchants) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) throw new Error(`Claude did not return a ${TOOL_NAME} tool call despite a forced tool_choice`);
  const parsed = toolUse.input as ToolInput;

  return parsed.suggestions.map((s) => ({
    name: s.name,
    kind: s.kind,
    groupName: s.group_name,
    monthlyTargetCents: s.monthly_target_cents > 0 ? s.monthly_target_cents : null,
    reasoning: s.reasoning,
  }));
}
