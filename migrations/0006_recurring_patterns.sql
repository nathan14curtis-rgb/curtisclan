-- Recurring bill/income detection ("Recurring" page, formerly "Bills"):
-- match by vendor + day-of-month pattern, not exact amount — a utility
-- charge that's $200 one month and $240 the next from the same merchant
-- around the same day of the month is still the same recurring bill.
-- 'suggested' rows are detection output waiting on a person to confirm or
-- dismiss; only 'confirmed' rows are used to auto-match future
-- transactions (src/db/recurringPatterns.ts).

CREATE TABLE recurring_pattern (
  id                TEXT PRIMARY KEY,
  household_id      TEXT NOT NULL REFERENCES household(id),
  category_id       TEXT REFERENCES category(id), -- set once confirmed; null while only suggested
  merchant_pattern  TEXT NOT NULL, -- normalized_merchant (or raw_description) substring to match
  kind              TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
  day_of_month      INTEGER NOT NULL, -- 1-31, the typical day the charge/deposit lands
  day_tolerance     INTEGER NOT NULL DEFAULT 4,
  status            TEXT NOT NULL CHECK (status IN ('suggested', 'confirmed', 'dismissed')) DEFAULT 'suggested',
  sample_count      INTEGER NOT NULL DEFAULT 0, -- how many past transactions the detector saw when suggesting this
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recurring_pattern_household ON recurring_pattern(household_id);
CREATE INDEX idx_recurring_pattern_household_status ON recurring_pattern(household_id, status);
