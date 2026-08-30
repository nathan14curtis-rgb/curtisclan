import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { resolveReply, type OpenClarificationItem } from "../src/messaging/replyResolver";

const openItems: OpenClarificationItem[] = [
  { transactionId: "txn_walmart", merchant: "WALMART", amountCents: -3500, postedAt: "2026-03-10" },
  { transactionId: "txn_starbucks", merchant: "STARBUCKS", amountCents: -2500, postedAt: "2026-03-10" },
  { transactionId: "txn_maverik", merchant: "MAVERIK", amountCents: -1400, postedAt: "2026-03-11" },
];

const categories = [
  { id: "cat_groceries", name: "Groceries" },
  { id: "cat_coffee", name: "Coffee" },
  { id: "cat_gas", name: "Gas" },
];

function fakeClient(toolInput: Record<string, unknown>) {
  const create = vi.fn().mockResolvedValue({
    content: [{ type: "tool_use", id: "tu_1", name: "resolve_clarifications", input: toolInput }],
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe("resolveReply", () => {
  it("forces the tool call with an enum scoped to the open transaction ids and categories", async () => {
    const { client, create } = fakeClient({ matches: [], unmatched_transaction_ids: [], unresolved_text: "" });
    await resolveReply(client, "claude-haiku-4-5-20251001", { replyText: "walmart was groceries", openItems, categories });

    const params = create.mock.calls[0]![0];
    expect(params.tool_choice).toEqual({ type: "tool", name: "resolve_clarifications" });
    const tool = params.tools[0];
    expect(tool.input_schema.properties.matches.items.properties.transaction_id.enum).toEqual(openItems.map((i) => i.transactionId));
    expect(tool.input_schema.properties.matches.items.properties.category_id.enum).toEqual(categories.map((c) => c.id));
  });

  it("maps a full batch resolution: PLAN.md §5.2's example reply", async () => {
    const { client } = fakeClient({
      matches: [
        { transaction_id: "txn_walmart", category_id: "cat_groceries", memo: "groceries", confidence: 0.95, source_span: "walmart was groceries" },
        { transaction_id: "txn_starbucks", category_id: "cat_coffee", memo: "coffee", confidence: 0.95, source_span: "starbucks was coffee" },
        { transaction_id: "txn_maverik", category_id: "cat_gas", memo: "gas", confidence: 0.95, source_span: "maverik was gas" },
      ],
      unmatched_transaction_ids: [],
      unresolved_text: "",
    });

    const result = await resolveReply(client, "claude-haiku-4-5-20251001", {
      replyText: "walmart was groceries, starbucks was coffee, maverik was gas",
      openItems,
      categories,
    });

    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]).toEqual({
      transactionId: "txn_walmart",
      categoryId: "cat_groceries",
      memo: "groceries",
      confidence: 0.95,
      sourceSpan: "walmart was groceries",
    });
    expect(result.unmatchedTransactionIds).toEqual([]);
    expect(result.unresolvedText).toBeNull();
  });

  it("maps a partial answer, leaving the rest unmatched (PLAN.md §5.2)", async () => {
    const { client } = fakeClient({
      matches: [{ transaction_id: "txn_walmart", category_id: "cat_groceries", memo: "groceries", confidence: 0.9, source_span: "first one groceries" }],
      unmatched_transaction_ids: ["txn_starbucks", "txn_maverik"],
      unresolved_text: "",
    });

    const result = await resolveReply(client, "claude-haiku-4-5-20251001", { replyText: "first one groceries", openItems, categories });
    expect(result.matches).toHaveLength(1);
    expect(result.unmatchedTransactionIds).toEqual(["txn_starbucks", "txn_maverik"]);
  });

  it("surfaces unresolved text as null when empty, not an empty string", async () => {
    const { client } = fakeClient({ matches: [], unmatched_transaction_ids: [], unresolved_text: "" });
    const result = await resolveReply(client, "claude-haiku-4-5-20251001", { replyText: "huh?", openItems: [], categories });
    expect(result.unresolvedText).toBeNull();
  });
});
