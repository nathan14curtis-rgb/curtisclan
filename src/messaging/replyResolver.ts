import type Anthropic from "@anthropic-ai/sdk";
import type { CategoryOption } from "../categorization/llm";

/**
 * The batch reply resolver (PLAN.md §5.2): one Claude call takes the raw
 * reply plus every open transaction for that phone number and returns
 * the pairings. Deliberately separate from src/categorization/llm.ts's
 * classifier — different input shape (a free-text reply plus a list of
 * open items, not one transaction) and a different output contract.
 */

export interface OpenClarificationItem {
  transactionId: string;
  merchant: string;
  amountCents: number;
  postedAt: string; // 'YYYY-MM-DD'
}

export interface ReplyResolverInput {
  replyText: string;
  openItems: OpenClarificationItem[];
  categories: CategoryOption[];
}

export interface ReplyResolverMatch {
  transactionId: string;
  categoryId: string;
  memo: string;
  confidence: number;
  sourceSpan: string;
}

export interface ReplyResolverResult {
  matches: ReplyResolverMatch[];
  unmatchedTransactionIds: string[];
  unresolvedText: string | null;
}

const TOOL_NAME = "resolve_clarifications";

function buildTool(openItems: OpenClarificationItem[], categories: CategoryOption[]) {
  const transactionIds = openItems.map((i) => i.transactionId);
  const categoryIds = categories.map((c) => c.id);
  return {
    name: TOOL_NAME,
    description: "Pair a person's free-text reply against a list of open (uncategorized) transactions.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        matches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              transaction_id: { type: "string", enum: transactionIds },
              category_id: { type: "string", enum: categoryIds },
              memo: { type: "string", description: "The verbatim (or lightly cleaned) memo for this transaction from the reply." },
              // No minimum/maximum — Anthropic's strict/custom tools
              // reject numeric range constraints (src/categorization/llm.ts
              // hit the same 400 first). Range is prompt-enforced instead.
              confidence: { type: "number" },
              source_span: { type: "string", description: "The part of the reply text that drove this specific pairing." },
            },
            required: ["transaction_id", "category_id", "memo", "confidence", "source_span"],
            additionalProperties: false,
          },
        },
        unmatched_transaction_ids: {
          type: "array",
          items: { type: "string", enum: transactionIds },
          description: "Open transactions the reply did not address — leave these open, never guess.",
        },
        unresolved_text: {
          type: "string",
          description: "Any part of the reply that didn't answer anything (empty string if none).",
        },
      },
      required: ["matches", "unmatched_transaction_ids", "unresolved_text"],
      additionalProperties: false,
    },
  };
}

function buildSystemPrompt(categories: CategoryOption[]): string {
  const taxonomy = categories.map((c) => `- ${c.id}: ${c.name}`).join("\n");
  return [
    "You are matching a reply text to a list of open (uncategorized) transactions for a household budgeting app.",
    "Categories to choose from — never invent a category_id that isn't in this list:",
    taxonomy,
    "",
    "The reply may name items by number, by merchant, by 'the big one', by amount, or refer to 'all' / 'the rest' / 'except X'.",
    "Rules:",
    "- Apply what the reply actually answers. Never guess at an item the reply doesn't address — put its transaction_id in unmatched_transaction_ids instead.",
    "- If two open items share the same merchant and the reply gives one answer for that merchant ('starbucks was coffee'), apply it to both — unless the reply distinguishes them (e.g. by amount, 'the $25 one'), in which case match only the one it actually specifies and leave the other unmatched.",
    "- confidence reflects how directly the reply specifies this pairing. A low confidence for a genuinely ambiguous pairing is correct and expected — do not inflate it.",
    "- memo should capture what the person actually said about that charge (e.g. 'lunch with a friend'), verbatim where possible — it's stored as-is and is more useful in six months than a bare category name.",
    "- unresolved_text is any part of the reply that isn't about categorizing an open transaction (a question, a comment, something unrelated). Leave it empty if the whole reply was about categorizing.",
  ].join("\n");
}

function buildUserMessage(input: ReplyResolverInput): string {
  const items = input.openItems
    .map((item, i) => `${i + 1}. $${(Math.abs(item.amountCents) / 100).toFixed(2)} — ${item.merchant} — ${item.postedAt} (id: ${item.transactionId})`)
    .join("\n");
  return [`Open transactions:`, items, ``, `Reply to match against them:`, `"${input.replyText}"`].join("\n");
}

interface ToolInput {
  matches: Array<{ transaction_id: string; category_id: string; memo: string; confidence: number; source_span: string }>;
  unmatched_transaction_ids: string[];
  unresolved_text: string;
}

export async function resolveReply(client: Anthropic, model: string, input: ReplyResolverInput): Promise<ReplyResolverResult> {
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: [{ type: "text", text: buildSystemPrompt(input.categories), cache_control: { type: "ephemeral" } }],
    tools: [buildTool(input.openItems, input.categories)],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });

  const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) throw new Error(`Claude did not return a ${TOOL_NAME} tool call despite a forced tool_choice`);
  const parsed = toolUse.input as ToolInput;

  return {
    matches: parsed.matches.map((m) => ({
      transactionId: m.transaction_id,
      categoryId: m.category_id,
      memo: m.memo,
      confidence: m.confidence,
      sourceSpan: m.source_span,
    })),
    unmatchedTransactionIds: parsed.unmatched_transaction_ids,
    unresolvedText: parsed.unresolved_text || null,
  };
}
