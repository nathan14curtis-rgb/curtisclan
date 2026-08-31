import Anthropic from "@anthropic-ai/sdk";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";
import { getAccount } from "../db/accounts";
import { listCategories } from "../db/categories";
import { createClarification, getLatestClarificationForTransaction, resolveAskee } from "../db/clarifications";
import { getMerchantMemory } from "../db/merchantMemory";
import { listRules } from "../db/rules";
import { applyCategorization, getTransaction, listRecentCategorizedByMerchant } from "../db/transactions";
import { categorize } from "./cascade";
import { ClaudeLlmClassifier, UnimplementedLlmClassifier, type LlmClassifier } from "./llm";
import type { CandidateTransaction } from "./types";

function buildLlmClassifier(env: Env): LlmClassifier {
  if (!env.ANTHROPIC_API_KEY) return new UnimplementedLlmClassifier();
  return new ClaudeLlmClassifier(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }));
}

/**
 * PLAN.md §1's example: "$47.83 at THE HIVE MERCANTILE. What was this?"
 * — with the account name appended once questions go to a shared group
 * thread (src/messaging/groupChat.ts) rather than straight to the card
 * owner, since which card a charge landed on is no longer implicit from
 * who the text arrived at.
 */
function buildQuestionText(amountCents: number, merchant: string | null, rawDescription: string, accountName: string): string {
  const dollars = (Math.abs(amountCents) / 100).toFixed(2);
  return `$${dollars} at ${merchant ?? rawDescription} (${accountName}). What was this?`;
}

/**
 * Runs one transaction through the categorization cascade (PLAN.md §6)
 * and either applies a confident result, or applies the best guess (if
 * any) and asks — the 'categorize' queue job's handler. Idempotent: a
 * redelivered job for an already-categorized transaction, or one with an
 * open clarification already sent, is a no-op.
 *
 * `skipClarification` (set for a newly-linked item's historical backfill,
 * src/plaid/sync.ts) still runs the full cascade — rules, merchant
 * memory, and the LLM all still apply — it only suppresses the last
 * resort: never text a household member about a transaction from before
 * they linked the account. An unresolved one is left uncategorized for
 * the dashboard's review queue instead of an iMessage.
 */
export async function categorizeTransaction(
  env: Env,
  householdId: string,
  transactionId: string,
  opts: { skipClarification?: boolean } = {},
): Promise<void> {
  const transaction = await getTransaction(env.DB, householdId, transactionId);
  if (transaction.is_transfer || transaction.category_id) return;

  const account = await getAccount(env.DB, householdId, transaction.account_id);
  const [allCategories, rules, merchantMemory, similar] = await Promise.all([
    listCategories(env.DB, householdId),
    listRules(env.DB, householdId),
    transaction.normalized_merchant ? getMerchantMemory(env.DB, householdId, transaction.normalized_merchant) : Promise.resolve(null),
    transaction.normalized_merchant ? listRecentCategorizedByMerchant(env.DB, householdId, transaction.normalized_merchant) : Promise.resolve([]),
  ]);

  const candidate: CandidateTransaction = {
    id: transaction.id,
    merchant: transaction.normalized_merchant,
    rawDescription: transaction.raw_description,
    amountCents: transaction.amount_cents,
    postedAt: transaction.posted_at,
    accountType: account.type,
    ownerUserId: account.owner_user_id,
  };

  // Only expense/savings categories are funded envelopes and valid
  // targets for the cascade — income/transfer are never what a charge
  // gets filed under (PLAN.md §3), and an archived one shouldn't be
  // offered as a fresh answer.
  const categoryOptions = allCategories
    .filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings"))
    .map((c) => ({ id: c.id, name: c.name }));

  const result = await categorize(candidate, {
    rules,
    merchantMemory,
    llm: buildLlmClassifier(env),
    categories: categoryOptions,
    similarPastTransactions: similar
      .filter((s): s is typeof s & { category_id: string } => s.category_id !== null)
      .map((s) => ({ merchant: s.normalized_merchant ?? s.raw_description, amountCents: s.amount_cents, categoryId: s.category_id })),
  });

  console.log(
    `[categorize] ${transactionId} layer=${result.layer} confidence=${"confidence" in result ? result.confidence : "n/a"} categoryId=${result.categoryId ?? "none"} needsClarification=${result.needsClarification}`,
  );

  if (result.categoryId) {
    await applyCategorization(env.DB, householdId, transactionId, {
      categoryId: result.categoryId,
      method: result.layer === "rule" ? "rule" : result.layer === "memory" ? "memory" : "llm",
      confidence: result.confidence,
      model: result.layer === "llm" ? result.model : undefined,
      reasoning: result.layer === "llm" ? result.reasoning : undefined,
      promptVersion: result.layer === "llm" ? result.promptVersion : undefined,
      ruleId: result.layer === "rule" ? result.ruleId : undefined,
    });
  }

  if (!result.needsClarification) return;

  if (opts.skipClarification) {
    console.log(`[categorize] ${transactionId} needs clarification but is from a historical backfill — leaving for dashboard review, not texting`);
    return;
  }

  const alreadyOpen = await getLatestClarificationForTransaction(env.DB, householdId, transactionId);
  if (alreadyOpen && alreadyOpen.status === "sent") {
    console.log(`[categorize] ${transactionId} clarification already sent — skipping`);
    return;
  }
  if (alreadyOpen && alreadyOpen.status === "queued") {
    // Still "queued" means its send_clarification job never actually got
    // through (dropped after exhausting the queue's retries, most likely)
    // — re-enqueue rather than leaving it stuck forever.
    console.log(`[categorize] ${transactionId} clarification ${alreadyOpen.id} still queued — re-sending`);
    const message: MessageQueueMessage = { type: "send_clarification", householdId, clarificationId: alreadyOpen.id };
    await env.MESSAGE_QUEUE.send(message);
    return;
  }

  const askee = await resolveAskee(env.DB, householdId, account);
  if (!askee) {
    console.log(`[categorize] ${transactionId} needs clarification but nobody is verified yet — left for dashboard review`);
    return;
  }

  const clarification = await createClarification(env.DB, householdId, {
    transactionId,
    userId: askee.id,
    questionText: buildQuestionText(transaction.amount_cents, transaction.normalized_merchant, transaction.raw_description, account.name),
  });
  console.log(`[categorize] ${transactionId} created clarification ${clarification.id}, asking user ${askee.id}`);

  const message: MessageQueueMessage = { type: "send_clarification", householdId, clarificationId: clarification.id };
  await env.MESSAGE_QUEUE.send(message);
}
