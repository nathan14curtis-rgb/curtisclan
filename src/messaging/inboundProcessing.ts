import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL } from "../categorization/llm";
import { describeError } from "../lib/errors";
import type { MessageQueueMessage } from "../lib/queueMessages";
import type { Category, Env, Transaction } from "../types";
import { createClarification, listOpenClarificationsForHousehold, markClarificationAnswered } from "../db/clarifications";
import { listCategories } from "../db/categories";
import { getEnvelopeByCategory, getEnvelopeMonthSummary } from "../db/envelopes";
import {
  applyCategorization,
  findRecentTransactionByMerchantSubstring,
  getTransaction,
  listRecentlyCategorizedTransactions,
} from "../db/transactions";
import { answerBudgetQuestion } from "./budgetQA";
import { sendToHouseholdGroup } from "./groupChat";
import { resolveReply, type OpenClarificationItem, type ReplyResolverResult } from "./replyResolver";

const FIX_PATTERN = /^\s*fix\s+(.+)$/i;
// A low-confidence pairing does not auto-apply — it stays open rather
// than risk a silent misfile (PLAN.md §5.3).
const MIN_MATCH_CONFIDENCE = 0.55;
// How far back a reply can reach to correct something without saying
// "fix" — wide enough to cover "the digest arrived, then a reply an hour
// later," narrow enough that a months-old transaction never gets swept up
// by an unrelated merchant name.
const RECENT_CORRECTION_WINDOW_HOURS = 48;

interface AppliedCorrection {
  merchant: string;
  amountCents: number;
  categoryName: string;
  remainingCents: number | null; // null when the category has no envelope
}

/**
 * Handles one inbound Sendblue text (PLAN.md §5.2–§5.4): "fix X"
 * corrections first, then the batch resolver against every open
 * clarification *and* every recently auto-categorized transaction for the
 * household's shared group thread — either spouse can answer or correct
 * anything recent, not just what's nominally still open. This is what
 * makes a daily-digest reply like "actually the uber was for business"
 * work without a rigid "fix <merchant>" syntax: the digest's own
 * transactions are exactly this same recently-categorized pool.
 * `userId` (who actually sent this text) is used only for attribution
 * (transaction_classification.created_by_user_id). Intent parsing for
 * "nothing open" replies (Q&A like "how much on food this month?") is
 * PLAN.md §13 Q13 — still an open decision, not built here; such a reply
 * is left unresolved rather than guessed at.
 */
export async function processInboundReply(env: Env, householdId: string, userId: string, content: string, anthropicClient?: Anthropic): Promise<void> {
  const fixMatch = content.match(FIX_PATTERN);
  if (fixMatch?.[1]) {
    await handleFixCommand(env, householdId, userId, fixMatch[1].trim());
    return;
  }

  const since = new Date(Date.now() - RECENT_CORRECTION_WINDOW_HOURS * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const [open, recent] = await Promise.all([
    listOpenClarificationsForHousehold(env.DB, householdId),
    listRecentlyCategorizedTransactions(env.DB, householdId, since),
  ]);
  if (open.length === 0 && recent.length === 0) {
    // Nothing to categorize against — this is either a budget question or
    // small talk. Try to answer it rather than dropping it silently.
    await replyToUnresolvedText(env, householdId, content);
    return;
  }

  if (!env.ANTHROPIC_API_KEY) {
    // A silent no-op here reads to the person on the other end as their
    // reply vanishing — PLAN.md §5.3's "the confirmation message is not
    // optional" applies just as much to "I can't process this yet" as it
    // does to a successful match.
    console.error(`[inboundReply] ANTHROPIC_API_KEY not configured — cannot resolve reply for household ${householdId}`);
    await sendToHouseholdGroup(env, householdId, "Got your reply, but I can't match it to a charge yet — that part isn't set up. You can still categorize from the dashboard.");
    return;
  }

  const openTransactions = await Promise.all(open.map((c) => getTransaction(env.DB, householdId, c.transaction_id)));

  // Dedup by transaction id — a transaction can carry both a low-confidence
  // guess (so it's already categorized) and an open clarification asking
  // to confirm it. Either representation is fine as a resolveReply
  // candidate; what matters is not asking Claude to match the same id twice.
  const transactionsById = new Map<string, Transaction>();
  for (const t of recent) transactionsById.set(t.id, t);
  for (const t of openTransactions) transactionsById.set(t.id, t);
  const allTransactions = [...transactionsById.values()];

  const candidateItems: OpenClarificationItem[] = allTransactions.map((t) => ({
    transactionId: t.id,
    merchant: t.normalized_merchant ?? t.raw_description,
    amountCents: t.amount_cents,
    postedAt: t.posted_at,
  }));

  // Income is a valid reply target too, e.g. "that was my paycheck" —
  // matches src/categorization/pipeline.ts's candidate list.
  const categories = (await listCategories(env.DB, householdId)).filter(
    (c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings" || c.kind === "income"),
  );
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));

  const client = anthropicClient ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  let result: ReplyResolverResult;
  try {
    result = await resolveReply(client, HAIKU_MODEL, { replyText: content, openItems: candidateItems, categories: categoryOptions });
  } catch (err) {
    // Previously this threw all the way out to the queue consumer, which
    // retries silently and, once retries are exhausted, drops the job —
    // the reply is gone with no signal to the person who sent it that
    // anything went wrong at all. Fail loud to them instead; a transient
    // error is cheap for them to recover from by just replying again.
    console.error(`[inboundReply] resolveReply failed for household ${householdId}: ${describeError(err)}`);
    await sendToHouseholdGroup(env, householdId, "Got your reply, but hit a hiccup matching it — try again in a bit, or categorize it from the dashboard.");
    return;
  }

  const clarificationByTransactionId = new Map(open.map((c) => [c.transaction_id, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const applied: AppliedCorrection[] = [];

  for (const match of result.matches) {
    if (match.confidence < MIN_MATCH_CONFIDENCE) continue;
    const category = categoryById.get(match.categoryId);
    const txn = transactionsById.get(match.transactionId);
    if (!category || !txn) continue;

    await applyCategorization(env.DB, householdId, match.transactionId, {
      categoryId: match.categoryId,
      memo: match.memo,
      method: "human",
      createdByUserId: userId,
    });

    const clarification = clarificationByTransactionId.get(match.transactionId);
    if (clarification) await markClarificationAnswered(env.DB, clarification.id);

    applied.push({
      merchant: txn.normalized_merchant ?? txn.raw_description,
      amountCents: txn.amount_cents,
      categoryName: category.name,
      remainingCents: await remainingThisMonth(env, householdId, category),
    });
  }

  if (applied.length === 0) {
    // Claude ran and genuinely found nothing to apply — every candidate
    // was either unmatched or below MIN_MATCH_CONFIDENCE. If Claude flagged
    // part of the reply as an actual question/comment, answer it instead of
    // the generic "couldn't match" — that's the conversational path most
    // plain replies ("how much left on groceries?") actually take.
    console.log(`[inboundReply] household ${householdId}: no confident matches (${result.matches.length} candidate match(es), all below threshold or unresolved)`);
    if (result.unresolvedText) {
      await replyToUnresolvedText(env, householdId, result.unresolvedText);
    } else {
      await sendToHouseholdGroup(env, householdId, "Got your reply, but couldn't match it confidently to a specific charge — check the dashboard to categorize it manually.");
    }
    return;
  }

  // The confirmation message is not optional (PLAN.md §5.3): batching
  // removes the self-correcting property of one-at-a-time asks, so every
  // resolution is echoed back for a two-second correction.
  let confirmationText = buildConfirmationText(applied);
  if (result.unresolvedText) {
    const answer = await answerBudgetQuestion(env, householdId, result.unresolvedText).catch((err) => {
      console.error(`[inboundReply] answerBudgetQuestion failed for household ${householdId}: ${describeError(err)}`);
      return null;
    });
    if (answer) confirmationText += `\n\n${answer}`;
  }
  await sendToHouseholdGroup(env, householdId, confirmationText);
}

/** A reply that named nothing to categorize — try to answer it as a budget
 * question before giving up. Never silent (PLAN.md §5.3's rule applies here
 * too): a question deserves an answer, and even "couldn't answer that" is
 * better than the person wondering if their text went through. */
async function replyToUnresolvedText(env: Env, householdId: string, text: string): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) {
    await sendToHouseholdGroup(env, householdId, "Got it, but I can't answer questions yet — that part isn't set up.");
    return;
  }
  try {
    const answer = await answerBudgetQuestion(env, householdId, text);
    await sendToHouseholdGroup(env, householdId, answer ?? "Not sure how to answer that one — try asking about a specific category.");
  } catch (err) {
    console.error(`[inboundReply] answerBudgetQuestion failed for household ${householdId}: ${describeError(err)}`);
    await sendToHouseholdGroup(env, householdId, "Hit a hiccup answering that — try again in a bit.");
  }
}

/** The envelope's running balance through the current month — "how much
 * is actually still safe to spend," per this app's carryover model
 * (PLAN.md §8), not just this month's allocation minus this month's
 * spend. Null only if the category somehow has no envelope. */
async function remainingThisMonth(env: Env, householdId: string, category: Category): Promise<number | null> {
  const envelope = await getEnvelopeByCategory(env.DB, householdId, category.id);
  if (!envelope) return null;
  const month = new Date().toISOString().slice(0, 7);
  const summary = await getEnvelopeMonthSummary(env.DB, householdId, envelope.id, month);
  return summary.balanceCents;
}

function formatRemaining(remainingCents: number): string {
  const dollars = (Math.abs(remainingCents) / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return remainingCents < 0 ? `over by $${dollars}` : `$${dollars} left`;
}

function buildConfirmationText(applied: AppliedCorrection[]): string {
  const lines = applied.map((a) => {
    const amount = `$${(Math.abs(a.amountCents) / 100).toFixed(2)}`;
    const remaining = a.remainingCents === null ? "" : ` — ${formatRemaining(a.remainingCents)} this month`;
    return `Confirmed! ${amount} at ${a.merchant} matched to ${a.categoryName}${remaining}`;
  });
  return [...lines, "", 'Reply "fix <merchant>" if I got one wrong.'].join("\n");
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
