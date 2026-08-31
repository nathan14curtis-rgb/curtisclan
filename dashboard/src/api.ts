/**
 * Thin fetch wrapper over the Worker's REST API. Same-origin in
 * production (served by the same Worker as Workers Assets); proxied to a
 * local `wrangler dev` in `npm run dev` (see vite.config.ts).
 */

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}: ${JSON.stringify(body)}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

export interface Household {
  id: string;
  name: string;
  timezone: string;
  group_chat_id: string | null;
}

export interface User {
  id: string;
  household_id: string;
  name: string;
  phone_e164: string | null;
  phone_verified_at: string | null;
}

export interface Account {
  id: string;
  household_id: string;
  owner_user_id: string | null;
  name: string;
  type: "depository_checking" | "depository_savings" | "credit_card" | "other";
  mask: string | null;
  plaid_item_id: string | null;
  plaid_account_id: string | null;
  status: "active" | "login_required" | "removed";
}

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income" | "savings" | "transfer";
  archived_at: string | null;
}

export interface CsvImportSummary {
  imported: number;
  skippedDuplicates: number;
  unmatchedCategoryNames: string[];
}

export const api = {
  createHousehold: (name: string) => request<Household>("/households", { method: "POST", body: JSON.stringify({ name }) }),
  getHousehold: (householdId: string) => request<Household>(`/households/${householdId}`),

  listUsers: (householdId: string) => request<User[]>(`/households/${householdId}/users`),
  createUser: (householdId: string, name: string) =>
    request<User>(`/households/${householdId}/users`, { method: "POST", body: JSON.stringify({ name }) }),
  verifyPhone: (householdId: string, userId: string, phoneE164: string) =>
    request<User>(`/households/${householdId}/users/${userId}/verify-phone`, {
      method: "POST",
      body: JSON.stringify({ phoneE164 }),
    }),

  listAccounts: (householdId: string) => request<Account[]>(`/households/${householdId}/accounts`),
  createAccount: (householdId: string, input: { name: string; type: Account["type"]; ownerUserId?: string }) =>
    request<Account>(`/households/${householdId}/accounts`, { method: "POST", body: JSON.stringify(input) }),

  listCategories: (householdId: string) => request<Category[]>(`/households/${householdId}/categories`),

  createLinkToken: (householdId: string, userId: string) =>
    request<{ link_token: string; expiration: string }>(`/households/${householdId}/plaid/link-token`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  exchangePlaidToken: (householdId: string, publicToken: string, institutionName?: string) =>
    request<{ itemId: string }>(`/households/${householdId}/plaid/exchange-token`, {
      method: "POST",
      body: JSON.stringify({ publicToken, institutionName }),
    }),

  importCsv: (
    householdId: string,
    input: { accountId: string; csv: string; columnMapping: { date: string; description: string; amount: string; category?: string; memo?: string } },
  ) => request<CsvImportSummary>(`/households/${householdId}/import/csv`, { method: "POST", body: JSON.stringify(input) }),
};
