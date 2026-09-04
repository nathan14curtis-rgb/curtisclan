-- Spending Plan editing, phase 1 (docs/SPENDING_PLAN_EDITING.md).
--
-- Three things the Spending Plan needs before its rows can be edited the
-- way Simplifi's are: tags on a transaction, projected occurrences of a
-- recurring series (so an upcoming paycheck is a row before any
-- transaction exists), and somewhere to record a series' expected amount.

-- Free-form labels, orthogonal to category: a transaction has exactly one
-- category but any number of tags ("vacation", "reimbursable"). Unique per
-- household by name so the same tag can't be created twice from two
-- devices.
CREATE TABLE tag (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (household_id, name)
);
CREATE INDEX idx_tag_household ON tag(household_id);

CREATE TABLE transaction_tag (
  transaction_id  TEXT NOT NULL REFERENCES "transaction"(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (transaction_id, tag_id)
);
CREATE INDEX idx_transaction_tag_tag ON transaction_tag(tag_id);

-- One materialized occurrence of a confirmed recurring_pattern: the 4th's
-- paycheck and the 20th's are two rows, so one of them can carry a
-- different amount, be skipped, or be linked to a posted transaction
-- without any of that touching the series itself.
--
-- Materialized rather than derived on read precisely because of those
-- per-occurrence edits — a derived list has nowhere to hang an override.
-- Regeneration (src/envelopes/occurrences.ts) upserts on
-- (pattern_id, due_date), so re-running it is idempotent and never
-- clobbers an override or a skip.
CREATE TABLE series_occurrence (
  id                     TEXT PRIMARY KEY,
  household_id           TEXT NOT NULL REFERENCES household(id),
  pattern_id             TEXT NOT NULL REFERENCES recurring_pattern(id) ON DELETE CASCADE,
  month                  TEXT NOT NULL,          -- 'YYYY-MM', the month due_date falls in
  -- What the schedule itself produced, never edited. Regeneration keys off
  -- this rather than due_date so that moving an occurrence ("rent clears
  -- on the 3rd this month") doesn't leave a hole the next generation fills
  -- with a duplicate at the original date.
  scheduled_date         TEXT NOT NULL,
  due_date               TEXT NOT NULL,          -- ISO date it is actually expected; starts equal to scheduled_date
  -- The projected amount as of generation time. Null falls back to the
  -- pattern's expected_amount_cents; see resolveOccurrenceAmountCents.
  amount_cents           INTEGER,
  -- A one-month change ("the water bill is $240 this month"), which
  -- survives regeneration and never edits the series.
  amount_override_cents  INTEGER,
  status                 TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'matched', 'skipped')),
  matched_transaction_id TEXT REFERENCES "transaction"(id) ON DELETE SET NULL,
  -- A transaction a person explicitly unlinked from this occurrence.
  -- Without it, "Unlink transaction" would be undone by the very next
  -- reconcile, which would just re-match the same pair.
  unlinked_transaction_id TEXT REFERENCES "transaction"(id) ON DELETE SET NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pattern_id, scheduled_date)
);
CREATE INDEX idx_series_occurrence_household_month ON series_occurrence(household_id, month);
CREATE INDEX idx_series_occurrence_txn ON series_occurrence(matched_transaction_id);

-- What this series is expected to cost/pay, so a projected occurrence has
-- an amount before anything has posted. Seeded from matched history by the
-- detector; editable from the series detail view.
ALTER TABLE recurring_pattern ADD COLUMN expected_amount_cents INTEGER;

-- Ending a series is not the same as dismissing a suggestion: a cancelled
-- subscription's history stays matched and its past occurrences stay on
-- the plan, but nothing new is projected past this date.
ALTER TABLE recurring_pattern ADD COLUMN ended_at TEXT;
