import type { SendGroupMessageResponse, SendMessageResponse } from "./types";

/**
 * Sendblue REST client (PLAN.md §2, §5). Auth is two headers, not a
 * bearer token — sb-api-key-id / sb-api-secret-key.
 */
export interface SendblueConfig {
  apiKeyId: string;
  apiSecretKey: string;
  fromNumber: string;
  baseUrl: string; // default https://api.sendblue.com/api
}

export class SendblueApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown) {
    super(`Sendblue API error ${status}: ${JSON.stringify(body)}`);
    this.name = "SendblueApiError";
  }
}

export async function sendMessage(
  config: SendblueConfig,
  input: { to: string; content: string; statusCallbackUrl?: string },
): Promise<SendMessageResponse> {
  const response = await fetch(`${config.baseUrl}/send-message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sb-api-key-id": config.apiKeyId,
      "sb-api-secret-key": config.apiSecretKey,
    },
    body: JSON.stringify({
      number: input.to,
      content: input.content,
      from_number: config.fromNumber,
      status_callback: input.statusCallbackUrl,
    }),
  });

  const json = await response.json();
  if (!response.ok) throw new SendblueApiError(response.status, json);
  return json as SendMessageResponse;
}

/**
 * POST /send-group-message (PLAN.md §5, extended for a household group
 * thread). Pass `numbers` the first time — Sendblue creates the group and
 * returns a `group_id`; every later send passes that `group_id` instead
 * to stay in the same thread rather than creating a new one each time.
 */
export async function sendGroupMessage(
  config: SendblueConfig,
  input: { numbers: string[]; content: string } | { groupId: string; content: string },
): Promise<SendGroupMessageResponse> {
  const body =
    "groupId" in input
      ? { group_id: input.groupId, content: input.content, from_number: config.fromNumber }
      : { numbers: input.numbers, content: input.content, from_number: config.fromNumber };

  const response = await fetch(`${config.baseUrl}/send-group-message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sb-api-key-id": config.apiKeyId,
      "sb-api-secret-key": config.apiSecretKey,
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (!response.ok) throw new SendblueApiError(response.status, json);
  return json as SendGroupMessageResponse;
}
