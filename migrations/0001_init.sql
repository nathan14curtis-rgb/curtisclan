-- Phase 0 foundations schema. See docs/PLAN.md §3 for the entity design
-- rationale. All money is signed integer cents — never floats (SQLite has
-- no decimal type).

CREATE TABLE household (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  timezone   TEXT NOT NULL DEFAULT 'America/Denver',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE user (
  id                  TEXT PRIMARY KEY,
  household_id        TEXT NOT NULL REFERENCES household(id),
  name                TEXT NOT NULL,
  -- Sendblue routing key. Null until the user has been added and completed
  -- the verification handshake (PLAN §5.0, §10).
  phone_e164          TEXT UNIQUE,
  phone_verified_at   TEXT,
  timezone            TEXT NOT NULL DEFAULT 'America/Denver',
  quiet_hours_start   TEXT, -- 'HH:MM', local to timezone
  quiet_hours_end     TEXT,
  notification_prefs  TEXT NOT NULL DEFAULT '{}', -- JSON
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_user_household ON user(household_id);

CREATE TABLE account (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL REFERENCES household(id),
  -- Routes an ambiguous charge to the right phone (PLAN §3). Nullable for
  -- joint accounts until §13 Q6 (ask a default vs. ask both) is settled.
  owner_user_id  TEXT REFERENCES user(id),
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('depository_checking', 'depository_savings', 'credit_card', 'other')),
  mask           TEXT, -- last 4 digits, display only

  plaid_item_id      TEXT,
  plaid_account_id   TEXT UNIQUE,
  -- Encrypted at rest with AES-GCM (Workers Web Crypto), key in Workers
  -- Secrets — never store a plaintext access token (PLAN §4.1, §10).
  plaid_access_token_ciphertext TEXT,
  plaid_access_token_iv         TEXT,

  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'login_required', 'removed')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_account_household ON account(household_id);
CREATE INDEX idx_account_owner ON account(owner_user_id);

-- Expense/savings categories are the budgeting envelopes; income/transfer
-- categories are never funded (PLAN §3).
CREATE TABLE category (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  parent_id     TEXT REFERENCES category(id),
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'savings', 'transfer')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, parent_id, name)
);
CREATE INDEX idx_category_household ON category(household_id);

-- The budgeting face of a category. One envelope per (expense|savings)
-- category. Archive, never delete: historical transactions reference it.
CREATE TABLE envelope (
  id                    TEXT PRIMARY KEY,
  household_id          TEXT NOT NULL REFERENCES household(id),
  category_id           TEXT NOT NULL UNIQUE REFERENCES category(id),
  group_name            TEXT NOT NULL DEFAULT 'Uncategorized',
  sort_order            INTEGER NOT NULL DEFAULT 0,
  monthly_target_cents  INTEGER,
  target_date           TEXT, -- ISO date, for goal-style envelopes
  archived_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_envelope_household ON envelope(household_id);

-- A ledger row, not a setting (PLAN §3, §8.1). Moving money between
-- envelopes writes two rows via related_envelope_id, fully reversible.
CREATE TABLE allocation (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id),
  envelope_id          TEXT NOT NULL REFERENCES envelope(id),
  month                TEXT NOT NULL, -- 'YYYY-MM'
  amount_cents         INTEGER NOT NULL, -- signed
  source               TEXT NOT NULL CHECK (source IN ('income_assignment', 'envelope_move', 'correction')),
  related_envelope_id  TEXT REFERENCES envelope(id), -- counterpart leg of a move
  note                 TEXT,
  created_by_user_id   TEXT REFERENCES user(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_allocation_envelope_month ON allocation(envelope_id, month);
CREATE INDEX idx_allocation_household ON allocation(household_id);

-- Month-end cache of computed balances. Performance only — always
-- regenerable from allocation + transaction (PLAN §3).
CREATE TABLE envelope_balance_snapshot (
  id             TEXT PRIMARY KEY,
  household_id   TEXT NOT NULL REFERENCES household(id),
  envelope_id    TEXT NOT NULL REFERENCES envelope(id),
  month          TEXT NOT NULL,
  balance_cents  INTEGER NOT NULL,
  computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (envelope_id, month)
);

CREATE TABLE "transaction" (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  account_id    TEXT NOT NULL REFERENCES account(id),

  -- Idempotency key for Plaid /transactions/sync (PLAN §4.2). Null for
  -- CSV-imported or manually entered rows.
  plaid_txn_id          TEXT UNIQUE,
  -- Set when this posted row supersedes a removed pending row, so category
  -- + memo + clarification history carry across the transition (PLAN §4.2).
  pending_plaid_txn_id  TEXT,

  posted_at            TEXT NOT NULL,
  -- Signed: negative = money out (spend), positive = money in.
  amount_cents          INTEGER NOT NULL,
  raw_description        TEXT NOT NULL,
  normalized_merchant     TEXT,
  category_id           TEXT REFERENCES category(id),
  memo                  TEXT,
  pending               INTEGER NOT NULL DEFAULT 0,
  is_transfer           INTEGER NOT NULL DEFAULT 0,
  excluded_from_budget  INTEGER NOT NULL DEFAULT 0,
  split_parent_id       TEXT REFERENCES "transaction"(id),
  source                TEXT NOT NULL DEFAULT 'plaid' CHECK (source IN ('plaid', 'csv_import', 'manual')),

  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_transaction_household ON "transaction"(household_id);
CREATE INDEX idx_transaction_account_posted ON "transaction"(account_id, posted_at);
CREATE INDEX idx_transaction_category ON "transaction"(category_id);
CREATE INDEX idx_transaction_merchant ON "transaction"(household_id, normalized_merchant);
CREATE INDEX idx_transaction_split_parent ON "transaction"(split_parent_id);

-- Separate from transaction on purpose: the audit trail and eval set for
-- categorization quality (PLAN §3, §6).
CREATE TABLE transaction_classification (
  id                   TEXT PRIMARY KEY,
  household_id         TEXT NOT NULL REFERENCES household(id),
  transaction_id       TEXT NOT NULL REFERENCES "transaction"(id),
  method               TEXT NOT NULL CHECK (method IN ('rule', 'memory', 'llm', 'human')),
  category_id          TEXT REFERENCES category(id),
  confidence           REAL,
  model                TEXT,
  reasoning            TEXT,
  alternatives         TEXT, -- JSON
  prompt_version       TEXT,
  rule_id              TEXT REFERENCES rule(id),
  prior_category_id    TEXT REFERENCES category(id), -- value being corrected, for method='human'
  created_by_user_id   TEXT REFERENCES user(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_classification_transaction ON transaction_classification(transaction_id);
CREATE INDEX idx_classification_household ON transaction_classification(household_id);

-- State machine driving reply-matching (PLAN §5).
CREATE TABLE clarification (
  id                TEXT PRIMARY KEY,
  household_id      TEXT NOT NULL REFERENCES household(id),
  transaction_id    TEXT NOT NULL REFERENCES "transaction"(id),
  user_id           TEXT NOT NULL REFERENCES user(id),
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'answered', 'timed_out')),
  question_text     TEXT,
  sendblue_handle   TEXT,
  sent_at           TEXT,
  answered_at       TEXT,
  timed_out_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clarification_user_status ON clarification(user_id, status);
CREATE INDEX idx_clarification_transaction ON clarification(transaction_id);

-- Raw Sendblue payloads, deduped on message_handle (PLAN §5.1).
CREATE TABLE inbound_message (
  id               TEXT PRIMARY KEY,
  household_id     TEXT REFERENCES household(id), -- unresolved until from_number is matched
  user_id          TEXT REFERENCES user(id),
  from_number      TEXT NOT NULL,
  message_handle   TEXT NOT NULL UNIQUE,
  content          TEXT NOT NULL,
  received_at      TEXT NOT NULL,
  processed_at     TEXT,
  raw_payload      TEXT NOT NULL -- full JSON
);
CREATE INDEX idx_inbound_from_number ON inbound_message(from_number);

-- The fast categorization path that keeps AI cost near zero (PLAN §6
-- layer 2). typical_amount/stddev back the amount-outlier guard.
CREATE TABLE merchant_memory (
  id                     TEXT PRIMARY KEY,
  household_id           TEXT NOT NULL REFERENCES household(id),
  normalized_merchant    TEXT NOT NULL,
  category_id            TEXT NOT NULL REFERENCES category(id),
  hit_count              INTEGER NOT NULL DEFAULT 0,
  last_confirmed_at      TEXT,
  typical_amount_cents   INTEGER,
  amount_stddev_cents    INTEGER,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, normalized_merchant)
);

CREATE TABLE rule (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  priority      INTEGER NOT NULL DEFAULT 100,
  conditions    TEXT NOT NULL, -- JSON predicate tree
  actions       TEXT NOT NULL, -- JSON action list
  source        TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai_suggested')),
  match_count   INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rule_household_priority ON rule(household_id, priority);
