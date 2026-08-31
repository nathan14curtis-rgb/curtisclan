/** Job payloads for TRANSACTION_QUEUE (ingest + categorization work) and
 * MESSAGE_QUEUE (outbound Sendblue sends, kept on a separate queue so a
 * low concurrency limit there doesn't also throttle Plaid sync). */

export type TransactionQueueMessage =
  | { type: "plaid_sync"; householdId: string; plaidItemId: string }
  | { type: "item_webhook"; householdId: string; plaidItemId: string; webhookCode: string }
  | { type: "categorize"; householdId: string; transactionId: string }
  | { type: "resolve_reply"; householdId: string; userId: string; inboundMessageId: string };

export type MessageQueueMessage =
  | { type: "send_clarification"; householdId: string; clarificationId: string }
  | { type: "daily_digest"; householdId: string };
