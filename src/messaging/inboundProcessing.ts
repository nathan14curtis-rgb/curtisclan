import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL } from "../categorization/llm";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { createClarification, listOpenClarificationsForHousehold, markClarificationAnswered } from "../db/clarifications";
import { listCategories } from "../db/categories";
import { applyCategorization, findRecentTransactionByMerchantSubstring, getTransaction } from "../db/transactions";
import { sendToHouseholdGroup } from "./groupChat";
import { resolveReply, type OpenClarificationItem } from "./replyResolver";

const FIX_PATTERN = /^\s*fix\s+(.+)$/i;
// A low-confidence pairing does not auto-apply — it stays open rather
// than risk a silent misfile (PLAN.md §5.3).
const MIN_MATCH_CONFIDENCE = 0.55;

/**
 * Handles one inbound Sendblue text (PLAN.md §5.2–§5.4): "fix X"
 * corrections first, then the batch resolver against every open
 * clarification for the household's shared group thread — either spouse
 * can answer anything open, not just charges nominally addressed to them.
 * `userId` (who actually sent this text) is used only for attribution
 * (transaction_classification.created_by_user_id). Intent parsing for
 * "nothing open" replies (Q&A like "how much on food this month?") is
 * PLAN.md §13 Q13 — still an open decision, not built here; such a reply
 * is left unresolved rather than guessed at.
 */
export async function processInboundReply(env: Env, householdId: string, userId: string, content: string): Promise<void> {
  const fixMatch = content.match(FIX_PATTERN);
  if (fixMatch?.[1]) {
    await handleFixCommand(env, householdId, userId, fixMatch[1].trim());
    return;
  }

  const open = await listOpenClarificationsForHousehold(env.DB, householdId);
  if (open.length === 0) return;
  if (!env.ANTHROPIC_API_KEY) return; // leaves clarifications open for the next reply once configured

  const transactions = await Promise.all(open.map((c) => getTransaction(env.DB, householdId, c.transaction_id)));
  const openItems: OpenClarificationItem[] = transactions.map((t) => ({
    transactionId: t.id,
    merchant: t.normalized_merchant ?? t.raw_description,
    amountCents: t.amount_cents,
    postedAt: t.posted_at,
  }));

  const categories = (await listCategories(env.DB, householdId))
    .filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings"))
    .map((c) => ({ id: c.id, name: c.name }));

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const result = await resolveReply(client, HAIKU_MODEL, { replyText: content, openItems, categories });

  const clarificationByTransactionId = new Map(open.map((c) => [c.transaction_id, c]));
  const applied: Array<{ merchant: string; amountCents: number; categoryName: string }> = [];

  for (const match of result.matches) {
    if (match.confidence < MIN_MATCH_CONFIDENCE) continue;
    const clarification = clarificationByTransactionId.get(match.transactionId);
    const category = categories.find((c) => c.id === match.categoryId);
    if (!clarification || !category) continue;

    await applyCategorization(env.DB, householdId, match.transactionId, {
      categoryId: match.categoryId,
      memo: match.memo,
      method: "human",
      createdByUserId: userId,
    });
    await markClarificationAnswered(env.DB, clarification.id);

    const txn = transactions.find((t) => t.id === match.transactionId);
    if (txn) applied.push({ merchant: txn.normalized_merchant ?? txn.raw_description, amountCents: txn.amount_cents, categoryName: category.name });
  }

  if (applied.length === 0) return;

  // The confirmation message is not optional (PLAN.md §5.3): batching
  // removes the self-correcting property of one-at-a-time asks, so every
  // resolution is echoed back for a two-second correction.
  await sendToHouseholdGroup(env, householdId, buildConfirmationText(applied));
}

function buildConfirmationText(applied: Array<{ merchant: string; amountCents: number; categoryName: string }>): string {
  const lines = applied.map((a) => `✓ ${a.merchant} $${(Math.abs(a.amountCents) / 100).toFixed(2)} → ${a.categoryName}`);
  return ["Got it:", ...lines, "", 'Reply "fix <merchant>" if I got one wrong.'].join("\n");
}

async function handleFixCommand(env: Env, householdId: string, userId: string, merchantText: string): Promise<void> {
  const transaction = await findRecentTransactionByMerchantSubstring(env.DB, householdId, merchantText);
  if (!transaction) {
    await sendToHouseholdGroup(env, householdId, `I don't see a recent charge matching "${merchantText}".`);
    return;
  }

  const clarification = await createClarification(env.DB, householdId, {
    transactionId: transaction.id,
    userId,
    questionText: `$${(Math.abs(transaction.amount_cents) / 100).toFixed(2)} at ${transaction.normalized_merchant ?? transaction.raw_description}. What should this be instead?`,
  });

  const message: MessageQueueMessage = { type: "send_clarification", householdId, clarificationId: clarification.id };
  await env.MESSAGE_QUEUE.send(message);
}
