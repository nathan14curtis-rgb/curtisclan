/** Minimal Plaid API types — only the fields this codebase actually reads.
 * Full schemas: https://plaid.com/docs/api/ */

export interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  type: string; // "depository" | "credit" | ...
  subtype: string | null; // "checking" | "savings" | "credit card" | ...
  balances: {
    current: number | null;
    available: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  // Plaid convention: POSITIVE = money out, NEGATIVE = money in — the
  // opposite of this codebase's internal sign convention (src/types.ts:
  // negative = spend). Every call site converting a Plaid transaction
  // negates this value; see src/plaid/sync.ts.
  amount: number;
  iso_currency_code: string | null;
  date: string; // 'YYYY-MM-DD'
  datetime: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
}

export interface PlaidRemovedTransaction {
  transaction_id: string;
}

export interface TransactionsSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  next_cursor: string;
  has_more: boolean;
  accounts: PlaidAccount[];
}

export interface LinkTokenCreateResponse {
  link_token: string;
  expiration: string;
}

export interface ItemPublicTokenExchangeResponse {
  access_token: string;
  item_id: string;
}

export interface AccountsBalanceGetResponse {
  accounts: PlaidAccount[];
}

/** JSON Web Key (ES256) as returned by /webhook_verification_key/get. */
export interface PlaidJwk {
  alg: "ES256";
  crv: "P-256";
  kid: string;
  kty: "EC";
  use: "sig";
  x: string;
  y: string;
}

export interface WebhookVerificationKeyGetResponse {
  key: PlaidJwk & { expired_at: string | null };
}

export interface PlaidErrorResponse {
  error_type: string;
  error_code: string;
  error_message: string;
  request_id: string;
}
