import { newId } from "../lib/id";
import type { ConversationChannel, ConversationMessage, ConversationRole } from "../types";
import { nowIso } from "./client";

/**
 * The household's running conversation with the bot (migrations/0009).
 * Every inbound text, every dashboard chat turn, and every message the bot
 * sends — scheduled or in reply — lands here in one ordered stream, which
 * is what lets a follow-up like "what about last month?" mean anything.
 */
export async function appendConversationMessage(
  db: D1Database,
  householdId: string,
  input: { role: ConversationRole; content: string; channel?: ConversationChannel; userId?: string | null },
): Promise<ConversationMessage> {
  const id = newId("cmsg");
  const now = nowIso();
  const channel = input.channel ?? "imessage";
  await db
    .prepare(
      `INSERT INTO conversation_message (id, household_id, user_id, role, content, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.userId ?? null, input.role, input.content, channel, now)
    .run();
  return {
    id,
    household_id: householdId,
    user_id: input.userId ?? null,
    role: input.role,
    content: input.content,
    channel,
    created_at: now,
  };
}

/**
 * The most recent turns, oldest-first (ready to hand to the Messages API).
 * Bounded two ways on purpose: a hard message count, and a recency cutoff
 * so a thread resumed a week later doesn't open with stale numbers the
 * model would treat as current.
 */
export async function listRecentConversation(
  db: D1Database,
  householdId: string,
  opts: { limit?: number; sinceIso?: string } = {},
): Promise<ConversationMessage[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const clauses = ["household_id = ?"];
  const params: unknown[] = [householdId];
  if (opts.sinceIso) {
    clauses.push("created_at >= ?");
    params.push(opts.sinceIso);
  }
  const { results } = await db
    .prepare(`SELECT * FROM conversation_message WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...params, limit)
    .all<ConversationMessage>();
  return results.reverse();
}
