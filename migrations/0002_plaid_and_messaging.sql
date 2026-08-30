-- Phase 1/3 additions: real Plaid Item tracking and account balances for
-- the Ready-to-Assign correction (PLAN.md §8.3.1).

-- A Plaid access_token belongs to an Item, not an account — one Chase
-- login can cover checking + savings under a single token. Phase 0 stored
-- the (encrypted) token per account, which is wrong once a household links
-- an item with more than one account: it would duplicate the same token
-- across rows instead of modeling the real relationship. Corrected here,
-- before any real token exists to migrate.
CREATE TABLE plaid_item (
  id                       TEXT PRIMARY KEY,
  household_id             TEXT NOT NULL REFERENCES household(id),
  plaid_item_id            TEXT NOT NULL UNIQUE,
  access_token_ciphertext  TEXT NOT NULL,
  access_token_iv          TEXT NOT NULL,
  institution_name         TEXT,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'removed')),
  -- /transactions/sync cursor (PLAN.md §4.2). Null cursor = full initial sync.
  cursor                   TEXT,
  last_synced_at           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_plaid_item_household ON plaid_item(household_id);

ALTER TABLE account DROP COLUMN plaid_access_token_ciphertext;
ALTER TABLE account DROP COLUMN plaid_access_token_iv;

-- Live balances, refreshed on every sync — what Ready to Assign's
-- credit-card correction (PLAN.md §8.3.1) reads instead of re-deriving
-- "spent but not yet paid" from the transaction ledger.
ALTER TABLE account ADD COLUMN current_balance_cents INTEGER;
ALTER TABLE account ADD COLUMN available_balance_cents INTEGER;
ALTER TABLE account ADD COLUMN balance_updated_at TEXT;

-- Plaid's webhook JWTs are signed with a key identified by `kid`; the
-- verification key is fetched from /webhook_verification_key/get and is
-- safe to cache since a given kid's key never changes, only expires
-- (PLAN.md §4.1 — webhook verification is real work, not a header
-- comparison).
CREATE TABLE plaid_webhook_key_cache (
  key_id      TEXT PRIMARY KEY,
  jwk         TEXT NOT NULL,
  expired_at  TEXT,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
