/** Domain types mirroring migrations/0001_init.sql. Kept as plain rows —
 * D1's driver returns exactly this shape, no ORM mapping layer. */

export type CategoryKind = "expense" | "income" | "savings" | "transfer";
export type AccountType = "depository_checking" | "depository_savings" | "credit_card" | "other";
export type AccountStatus = "active" | "login_required" | "removed";
export type TransactionSource = "plaid" | "csv_import" | "manual";
export type ClassificationMethod = "rule" | "memory" | "llm" | "human";
export type AllocationSource = "income_assignment" | "envelope_move" | "correction";
export type ClarificationStatus = "queued" | "sent" | "answered" | "timed_out";
export type RuleSource = "user" | "ai_suggested";

export interface Household {
  id: string;
  name: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  household_id: string;
  name: string;
  phone_e164: string | null;
  phone_verified_at: string | null;
  timezone: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  notification_prefs: string;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  household_id: string;
  owner_user_id: string | null;
  name: string;
  type: AccountType;
  mask: string | null;
  plaid_item_id: string | null;
  plaid_account_id: string | null;
  status: AccountStatus;
  current_balance_cents: number | null;
  available_balance_cents: number | null;
  balance_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PlaidItemStatus = "active" | "login_required" | "removed";

export interface PlaidItem {
  id: string;
  household_id: string;
  plaid_item_id: string;
  access_token_ciphertext: string;
  access_token_iv: string;
  institution_name: string | null;
  status: PlaidItemStatus;
  cursor: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  household_id: string;
  parent_id: string | null;
  name: string;
  kind: CategoryKind;
  sort_order: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Envelope {
  id: string;
  household_id: string;
  category_id: string;
  group_name: string;
  sort_order: number;
  monthly_target_cents: number | null;
  target_date: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Allocation {
  id: string;
  household_id: string;
  envelope_id: string;
  month: string; // 'YYYY-MM'
  amount_cents: number;
  source: AllocationSource;
  related_envelope_id: string | null;
  note: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface EnvelopeBalanceSnapshot {
  id: string;
  household_id: string;
  envelope_id: string;
  month: string;
  balance_cents: number;
  computed_at: string;
}

export interface Transaction {
  id: string;
  household_id: string;
  account_id: string;
  plaid_txn_id: string | null;
  pending_plaid_txn_id: string | null;
  posted_at: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
  category_id: string | null;
  memo: string | null;
  pending: 0 | 1;
  is_transfer: 0 | 1;
  excluded_from_budget: 0 | 1;
  split_parent_id: string | null;
  source: TransactionSource;
  created_at: string;
  updated_at: string;
}

export interface TransactionClassification {
  id: string;
  household_id: string;
  transaction_id: string;
  method: ClassificationMethod;
  category_id: string | null;
  confidence: number | null;
  model: string | null;
  reasoning: string | null;
  alternatives: string | null;
  prompt_version: string | null;
  rule_id: string | null;
  prior_category_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

export interface Clarification {
  id: string;
  household_id: string;
  transaction_id: string;
  user_id: string;
  status: ClarificationStatus;
  question_text: string | null;
  sendblue_handle: string | null;
  sent_at: string | null;
  answered_at: string | null;
  timed_out_at: string | null;
  created_at: string;
}

export interface InboundMessage {
  id: string;
  household_id: string | null;
  user_id: string | null;
  from_number: string;
  message_handle: string;
  content: string;
  received_at: string;
  processed_at: string | null;
  raw_payload: string;
}

export interface MerchantMemory {
  id: string;
  household_id: string;
  normalized_merchant: string;
  category_id: string;
  hit_count: number;
  last_confirmed_at: string | null;
  typical_amount_cents: number | null;
  amount_stddev_cents: number | null;
  created_at: string;
  updated_at: string;
}

export interface Rule {
  id: string;
  household_id: string;
  priority: number;
  conditions: string; // JSON predicate tree, see src/categorization/rules.ts
  actions: string; // JSON action list
  source: RuleSource;
  match_count: number;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface Env {
  DB: D1Database;
  TRANSACTION_QUEUE: Queue;
  MESSAGE_QUEUE: Queue;
  ENVIRONMENT: string;

  // Workers Secrets (wrangler secret put <NAME>) — see README for the
  // exact commands. Optional at the type level because local dev without
  // them should still boot; every call site that needs one checks it.
  TOKEN_ENCRYPTION_KEY?: string; // base64 AES-256 key, src/lib/crypto.ts
  PLAID_CLIENT_ID?: string;
  PLAID_SECRET?: string;
  PLAID_ENV?: "sandbox" | "production";
  SENDBLUE_API_KEY_ID?: string;
  SENDBLUE_API_SECRET_KEY?: string;
  SENDBLUE_SIGNING_SECRET?: string;
  SENDBLUE_API_BASE_URL?: string; // default https://api.sendblue.com/api
  ANTHROPIC_API_KEY?: string;
}
