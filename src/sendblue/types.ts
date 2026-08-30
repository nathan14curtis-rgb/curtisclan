/** Minimal Sendblue API types — only the fields this codebase reads.
 * https://docs.sendblue.com/api/ */

export interface SendMessageResponse {
  message_handle: string;
  status: string; // "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | ...
  error_code: number | null;
  from_number: string;
  to_number?: string;
}

/** Response from /send-group-message. group_id identifies the thread —
 * pass it back on every later send instead of `numbers` to stay in the
 * same conversation. */
export interface SendGroupMessageResponse {
  message_handle: string;
  group_id: string;
  status: string;
  error_code: number | null;
}

/** Inbound webhook payload for a received message. */
export interface InboundWebhookPayload {
  message_handle: string;
  from_number: string;
  to_number?: string;
  number?: string; // some Sendblue payload variants use `number` for the counterparty
  content: string;
  is_outbound: boolean;
  date_sent: string;
  status?: string;
  service?: string;
  group_id?: string;
}
