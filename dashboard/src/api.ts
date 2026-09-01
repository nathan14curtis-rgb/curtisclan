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

export type AccessLevel = "full" | "limited" | "view_only";
export type AssetType = "property" | "vehicle" | "appliance" | "other";
export type DocumentCategory = "insurance" | "warranty" | "identification" | "passwords";
export type VerifyState = "me" | "ai" | "none";
export type MaintenanceStatus = "scheduled" | "due_soon" | "overdue" | "done";

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
  role: string | null;
  access_level: AccessLevel;
  weekly_allowance_cents: number | null;
  note: string | null;
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
  current_balance_cents: number | null;
}

export interface Category {
  id: string;
  name: string;
  kind: "expense" | "income" | "savings" | "transfer";
  archived_at: string | null;
}

export interface Envelope {
  id: string;
  household_id: string;
  category_id: string;
  group_name: string;
  monthly_target_cents: number | null;
  // ISO date. A savings-goal envelope (PLAN.md §8.5: not a separate table)
  // is a kind='savings' envelope with this set — see the Goals page.
  target_date: string | null;
  archived_at: string | null;
}

export interface EnvelopeMonthSummary {
  month: string;
  allocatedCents: number;
  spentCents: number;
  balanceCents: number;
}

export interface Transaction {
  id: string;
  household_id: string;
  account_id: string;
  posted_at: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
  category_id: string | null;
  memo: string | null;
  pending: 0 | 1;
  is_transfer: 0 | 1;
  excluded_from_budget: 0 | 1;
  source: "plaid" | "csv_import" | "manual";
  verified_by_user_id: string | null;
  verified_at: string | null;
  // "me" (verified_by_user_id set) / "ai" (latest classification is
  // rule/memory/llm, never explicitly verified) / "none" — computed by
  // listTransactionsWithVerifyState, not stored.
  verify_state: VerifyState;
}

export interface CsvImportSummary {
  imported: number;
  skippedDuplicates: number;
  unmatchedCategoryNames: string[];
}

export interface Asset {
  id: string;
  household_id: string;
  name: string;
  type: AssetType;
  value_cents: number | null;
  notes: string | null;
  archived_at: string | null;
  documentCount: number;
  openTaskCount: number;
}

export interface Document {
  id: string;
  household_id: string;
  asset_id: string | null;
  name: string;
  category: DocumentCategory;
  owner_user_id: string | null;
  detail: string | null;
  archived_at: string | null;
}

export interface MaintenanceTask {
  id: string;
  household_id: string;
  asset_id: string;
  task: string;
  due_date: string;
  completed_at: string | null;
  notes: string | null;
  status: MaintenanceStatus;
}

export const api = {
  createHousehold: (name: string, creatorName: string) =>
    request<{ household: Household; userId: string }>("/households", { method: "POST", body: JSON.stringify({ name, creatorName }) }),
  getHousehold: (householdId: string) => request<Household>(`/households/${householdId}`),

  requestLoginCode: (phoneE164: string) => request<{ ok: true }>("/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164 }) }),
  verifyLoginCode: (phoneE164: string, code: string) =>
    request<{ householdId: string; userId: string; userName: string }>("/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ phoneE164, code }),
    }),
  getSession: () => request<{ householdId: string; userId: string; userName: string }>("/auth/session"),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  listUsers: (householdId: string) => request<User[]>(`/households/${householdId}/users`),
  createUser: (
    householdId: string,
    input: { name: string; role?: string; accessLevel?: AccessLevel; weeklyAllowanceCents?: number; note?: string },
  ) => request<User>(`/households/${householdId}/users`, { method: "POST", body: JSON.stringify(input) }),
  updateUser: (
    householdId: string,
    userId: string,
    input: { name?: string; role?: string | null; accessLevel?: AccessLevel; weeklyAllowanceCents?: number | null; note?: string | null },
  ) => request<User>(`/households/${householdId}/users/${userId}`, { method: "PATCH", body: JSON.stringify(input) }),
  verifyPhone: (householdId: string, userId: string, phoneE164: string) =>
    request<User>(`/households/${householdId}/users/${userId}/verify-phone`, {
      method: "POST",
      body: JSON.stringify({ phoneE164 }),
    }),

  listAccounts: (householdId: string) => request<Account[]>(`/households/${householdId}/accounts`),
  createAccount: (householdId: string, input: { name: string; type: Account["type"]; ownerUserId?: string }) =>
    request<Account>(`/households/${householdId}/accounts`, { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (householdId: string, accountId: string, input: { name?: string; ownerUserId?: string | null; status?: Account["status"] }) =>
    request<Account>(`/households/${householdId}/accounts/${accountId}`, { method: "PATCH", body: JSON.stringify(input) }),
  unlinkAccount: (householdId: string, accountId: string, deleteTransactions: boolean) =>
    request<{ ok: true; transactionsDeleted: number }>(`/households/${householdId}/accounts/${accountId}/unlink`, {
      method: "POST",
      body: JSON.stringify({ deleteTransactions }),
    }),

  listCategories: (householdId: string) => request<Category[]>(`/households/${householdId}/categories`),
  createCategory: (
    householdId: string,
    input: { name: string; kind: Category["kind"]; groupName?: string; monthlyTargetCents?: number; targetDate?: string },
  ) =>
    request<{ category: Category; envelope: Envelope | null }>(`/households/${householdId}/categories`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  renameCategory: (householdId: string, categoryId: string, name: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  archiveCategory: (householdId: string, categoryId: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}/archive`, { method: "POST" }),
  unarchiveCategory: (householdId: string, categoryId: string) =>
    request<Category>(`/households/${householdId}/categories/${categoryId}/unarchive`, { method: "POST" }),

  listEnvelopes: (householdId: string) => request<Envelope[]>(`/households/${householdId}/envelopes`),
  updateEnvelope: (
    householdId: string,
    envelopeId: string,
    input: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null },
  ) => request<Envelope>(`/households/${householdId}/envelopes/${envelopeId}`, { method: "PATCH", body: JSON.stringify(input) }),
  getEnvelopeSummary: (householdId: string, envelopeId: string, month: string) =>
    request<EnvelopeMonthSummary>(`/households/${householdId}/envelopes/${envelopeId}/summary?month=${month}`),
  // Every envelope's summary in one round trip — the Overview page's
  // envelope-fill chart needs all of them at once, and this replaces the
  // per-page Promise.all(envelopes.map(getEnvelopeSummary)) N+1 pattern.
  getEnvelopeSummaries: (householdId: string, month: string) =>
    request<Record<string, EnvelopeMonthSummary>>(`/households/${householdId}/envelopes/summary?month=${month}`),
  allocateToEnvelope: (householdId: string, envelopeId: string, input: { month: string; amountCents: number; note?: string }) =>
    request<{ ok: true }>(`/households/${householdId}/envelopes/${envelopeId}/allocate`, { method: "POST", body: JSON.stringify(input) }),
  moveMoneyBetweenEnvelopes: (
    householdId: string,
    input: { fromEnvelopeId: string; toEnvelopeId: string; month: string; amountCents: number; note?: string },
  ) => request<{ ok: true }>(`/households/${householdId}/envelopes/move`, { method: "POST", body: JSON.stringify(input) }),

  listTransactions: (
    householdId: string,
    filter: { accountId?: string; categoryId?: string; fromDate?: string; toDate?: string; needsReview?: boolean; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (filter.accountId) params.set("accountId", filter.accountId);
    if (filter.categoryId) params.set("categoryId", filter.categoryId);
    if (filter.fromDate) params.set("fromDate", filter.fromDate);
    if (filter.toDate) params.set("toDate", filter.toDate);
    if (filter.needsReview) params.set("needsReview", "true");
    if (filter.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return request<Transaction[]>(`/households/${householdId}/transactions${qs ? `?${qs}` : ""}`);
  },
  categorizeTransaction: (householdId: string, transactionId: string, input: { categoryId: string; memo?: string }) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/categorize`, { method: "PATCH", body: JSON.stringify(input) }),
  setTransactionExcluded: (householdId: string, transactionId: string, excluded: boolean) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/exclude`, {
      method: "POST",
      body: JSON.stringify({ excluded }),
    }),
  verifyTransaction: (householdId: string, transactionId: string, verifiedByUserId: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/verify`, {
      method: "POST",
      body: JSON.stringify({ verifiedByUserId }),
    }),
  unverifyTransaction: (householdId: string, transactionId: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/unverify`, { method: "POST" }),
  uncategorizeTransaction: (householdId: string, transactionId: string, clearedByUserId?: string) =>
    request<Transaction>(`/households/${householdId}/transactions/${transactionId}/uncategorize`, {
      method: "POST",
      body: JSON.stringify({ clearedByUserId }),
    }),

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

  listAssets: (householdId: string) => request<Asset[]>(`/households/${householdId}/assets`),
  createAsset: (householdId: string, input: { name: string; type: AssetType; valueCents?: number; notes?: string }) =>
    request<Omit<Asset, "documentCount" | "openTaskCount">>(`/households/${householdId}/assets`, { method: "POST", body: JSON.stringify(input) }),
  updateAsset: (
    householdId: string,
    assetId: string,
    input: { name?: string; type?: AssetType; valueCents?: number | null; notes?: string | null },
  ) => request<Omit<Asset, "documentCount" | "openTaskCount">>(`/households/${householdId}/assets/${assetId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveAsset: (householdId: string, assetId: string) =>
    request<Asset>(`/households/${householdId}/assets/${assetId}/archive`, { method: "POST" }),

  listDocuments: (householdId: string, filter: { category?: DocumentCategory; assetId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.category) params.set("category", filter.category);
    if (filter.assetId) params.set("assetId", filter.assetId);
    const qs = params.toString();
    return request<Document[]>(`/households/${householdId}/documents${qs ? `?${qs}` : ""}`);
  },
  createDocument: (householdId: string, input: { name: string; category: DocumentCategory; assetId?: string; ownerUserId?: string; detail?: string }) =>
    request<Document>(`/households/${householdId}/documents`, { method: "POST", body: JSON.stringify(input) }),
  updateDocument: (
    householdId: string,
    documentId: string,
    input: { name?: string; detail?: string | null; ownerUserId?: string | null; assetId?: string | null },
  ) => request<Document>(`/households/${householdId}/documents/${documentId}`, { method: "PATCH", body: JSON.stringify(input) }),
  archiveDocument: (householdId: string, documentId: string) =>
    request<Document>(`/households/${householdId}/documents/${documentId}/archive`, { method: "POST" }),

  listMaintenanceTasks: (householdId: string, filter: { assetType?: AssetType; assetId?: string; includeCompleted?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (filter.assetType) params.set("assetType", filter.assetType);
    if (filter.assetId) params.set("assetId", filter.assetId);
    if (filter.includeCompleted) params.set("includeCompleted", "true");
    const qs = params.toString();
    return request<MaintenanceTask[]>(`/households/${householdId}/maintenance${qs ? `?${qs}` : ""}`);
  },
  createMaintenanceTask: (householdId: string, input: { assetId: string; task: string; dueDate: string; notes?: string }) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance`, { method: "POST", body: JSON.stringify(input) }),
  updateMaintenanceTask: (householdId: string, taskId: string, input: { task?: string; dueDate?: string; notes?: string | null }) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}`, { method: "PATCH", body: JSON.stringify(input) }),
  completeMaintenanceTask: (householdId: string, taskId: string) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}/complete`, { method: "POST" }),
  reopenMaintenanceTask: (householdId: string, taskId: string) =>
    request<Omit<MaintenanceTask, "status">>(`/households/${householdId}/maintenance/${taskId}/reopen`, { method: "POST" }),
};
