import type {
  AccountsBalanceGetResponse,
  ItemPublicTokenExchangeResponse,
  LinkTokenCreateResponse,
  PlaidErrorResponse,
  TransactionsSyncResponse,
  WebhookVerificationKeyGetResponse,
} from "./types";

/**
 * Direct REST calls to Plaid via fetch (PLAN.md §2, §4.1): "Plaid's
 * official Node SDK is axios-based and fights the Workers runtime. Call
 * Plaid's REST API directly with fetch."
 */
export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: "sandbox" | "production";
}

export class PlaidApiError extends Error {
  constructor(public readonly body: PlaidErrorResponse) {
    super(`Plaid API error ${body.error_type}/${body.error_code}: ${body.error_message}`);
    this.name = "PlaidApiError";
  }
}

function baseUrl(env: PlaidConfig["env"]): string {
  return env === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
}

async function plaidFetch<T>(config: PlaidConfig, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl(config.env)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
  });
  const json = await response.json();
  if (!response.ok) throw new PlaidApiError(json as PlaidErrorResponse);
  return json as T;
}

export async function createLinkToken(
  config: PlaidConfig,
  input: { clientUserId: string; webhookUrl: string },
): Promise<LinkTokenCreateResponse> {
  return plaidFetch<LinkTokenCreateResponse>(config, "/link/token/create", {
    client_name: "Curtis Clan",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
    user: { client_user_id: input.clientUserId },
    webhook: input.webhookUrl,
  });
}

export async function exchangePublicToken(config: PlaidConfig, publicToken: string): Promise<ItemPublicTokenExchangeResponse> {
  return plaidFetch<ItemPublicTokenExchangeResponse>(config, "/item/public_token/exchange", {
    public_token: publicToken,
  });
}

/** One page of /transactions/sync. Callers loop while has_more is true —
 * see src/plaid/sync.ts (PLAN.md §4.2: cursor-based, idempotent by
 * design). */
export async function transactionsSyncPage(
  config: PlaidConfig,
  accessToken: string,
  cursor: string | null,
): Promise<TransactionsSyncResponse> {
  return plaidFetch<TransactionsSyncResponse>(config, "/transactions/sync", {
    access_token: accessToken,
    cursor: cursor ?? undefined,
    count: 500,
  });
}

export async function itemRemove(config: PlaidConfig, accessToken: string): Promise<void> {
  await plaidFetch(config, "/item/remove", { access_token: accessToken });
}

/** Sandbox-only: makes Plaid inject new fake transaction(s) into a linked
 * Sandbox Item and immediately send the real webhook back to us — lets
 * the whole ingest pipeline be exercised end to end without a real charge
 * (PLAN.md §4.0 testing note). Plaid rejects this outside sandbox. */
export async function sandboxFireWebhook(config: PlaidConfig, accessToken: string, webhookCode: string): Promise<void> {
  await plaidFetch(config, "/sandbox/item/fire_webhook", { access_token: accessToken, webhook_code: webhookCode });
}

export async function accountsBalanceGet(config: PlaidConfig, accessToken: string): Promise<AccountsBalanceGetResponse> {
  return plaidFetch<AccountsBalanceGetResponse>(config, "/accounts/balance/get", { access_token: accessToken });
}

export async function webhookVerificationKeyGet(config: PlaidConfig, keyId: string): Promise<WebhookVerificationKeyGetResponse> {
  return plaidFetch<WebhookVerificationKeyGetResponse>(config, "/webhook_verification_key/get", { key_id: keyId });
}
