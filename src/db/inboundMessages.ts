import { newId } from "../lib/id";
import type { InboundMessage } from "../types";
import { nowIso } from "./client";

export async function findInboundMessageByHandle(db: D1Database, messageHandle: string): Promise<InboundMessage | null> {
  return db.prepare(`SELECT * FROM inbound_message WHERE message_handle = ?`).bind(messageHandle).first<InboundMessage>();
}

export async function getInboundMessage(db: D1Database, id: string): Promise<InboundMessage | null> {
  return db.prepare(`SELECT * FROM inbound_message WHERE id = ?`).bind(id).first<InboundMessage>();
}

/** Raw Sendblue payloads, deduped on message_handle (PLAN.md §5.1) — kept
 * so a reply-parsing misfire can be debugged against the original text. */
export async function createInboundMessage(
  db: D1Database,
  input: {
    householdId: string | null;
    userId: string | null;
    fromNumber: string;
    messageHandle: string;
    content: string;
    receivedAt: string;
    rawPayload: unknown;
  },
): Promise<InboundMessage> {
  const id = newId("inmsg");
  await db
    .prepare(
      `INSERT INTO inbound_message (id, household_id, user_id, from_number, message_handle, content, received_at, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.householdId, input.userId, input.fromNumber, input.messageHandle, input.content, input.receivedAt, JSON.stringify(input.rawPayload))
    .run();
  return {
    id,
    household_id: input.householdId,
    user_id: input.userId,
    from_number: input.fromNumber,
    message_handle: input.messageHandle,
    content: input.content,
    received_at: input.receivedAt,
    processed_at: null,
    raw_payload: JSON.stringify(input.rawPayload),
  };
}

export async function markInboundMessageProcessed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE inbound_message SET processed_at = ? WHERE id = ?`).bind(nowIso(), id).run();
}

/** Most recent inbound texts for a household, plus the ones that arrived
 * from a number that matched no verified user (household_id IS NULL) —
 * those are invisible to every household-scoped query but are exactly the
 * rows that explain "I texted in and nothing happened." Powers
 * GET /api/households/:householdId/messaging/diagnostics. */
export async function listInboundMessagesForDiagnostics(db: D1Database, householdId: string, limit = 20): Promise<InboundMessage[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM inbound_message
         WHERE household_id = ? OR household_id IS NULL
         ORDER BY received_at DESC LIMIT ?`,
    )
    .bind(householdId, limit)
    .all<InboundMessage>();
  return results;
}
