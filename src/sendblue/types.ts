/** Minimal Sendblue API types — only the fields this codebase reads.
 * https://docs.sendblue.com/api/ */

export interface SendMessageResponse {
  message_handle: string;
  status: string; // "QUEUED" | "SENT" | "DELIVERED" | "FAILED" | ...
  error_code: number | null;
  from_number: string;
  to_number?: string;
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
}
