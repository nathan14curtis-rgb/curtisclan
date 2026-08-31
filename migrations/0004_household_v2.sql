-- Backend for the redesigned "Home Base" dashboard. Goals reuse the
-- existing envelope+target_date model (PLAN.md §8.5) — no schema change
-- there. This migration adds: household-member profile fields, a real
-- human-verification signal on transactions, and three new entities
-- (asset, document, maintenance_task) with no prior backing data at all.

ALTER TABLE user ADD COLUMN role TEXT; -- free text, e.g. "Parent · admin", "Age 16"
ALTER TABLE user ADD COLUMN access_level TEXT NOT NULL DEFAULT 'full'
  CHECK (access_level IN ('full', 'limited', 'view_only'));
ALTER TABLE user ADD COLUMN weekly_allowance_cents INTEGER;
ALTER TABLE user ADD COLUMN note TEXT;

-- Explicit human confirmation, not a computed aggregate — PLAN.md's
-- derive-don't-store rule (for balances) doesn't apply here. The
-- "auto-verified" state shown in the dashboard is derived instead from the
-- existing transaction_classification audit trail (src/db/transactions.ts)
-- rather than a second, potentially-conflicting column.
ALTER TABLE "transaction" ADD COLUMN verified_by_user_id TEXT REFERENCES user(id);
ALTER TABLE "transaction" ADD COLUMN verified_at TEXT;

CREATE TABLE asset (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('property', 'vehicle', 'appliance', 'other')),
  value_cents   INTEGER,
  notes         TEXT,
  archived_at   TEXT, -- archive, never delete — document/maintenance_task reference it
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_asset_household ON asset(household_id);

CREATE TABLE document (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  asset_id      TEXT REFERENCES asset(id), -- nullable: Passwords/etc. aren't tied to one asset
  name          TEXT NOT NULL,
  category      TEXT NOT NULL CHECK (category IN ('insurance', 'warranty', 'identification', 'passwords')),
  owner_user_id TEXT REFERENCES user(id), -- null = "Shared"
  detail        TEXT, -- free text, e.g. "Renews Jan 15, 2027" — metadata only, no file storage (no R2 binding)
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_document_household ON document(household_id);
CREATE INDEX idx_document_asset ON document(asset_id);

-- asset_id is NOT NULL: the Maintenance page's House/Car split filters by
-- the linked asset's type via a join, not a free-text label on the task —
-- the Assets page's per-asset open-task counts only reconcile against a
-- specific asset instance.
CREATE TABLE maintenance_task (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES household(id),
  asset_id      TEXT NOT NULL REFERENCES asset(id),
  task          TEXT NOT NULL,
  due_date      TEXT NOT NULL, -- ISO date
  completed_at  TEXT, -- null = open; status (scheduled/due_soon/overdue/done) derived at read time
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_maintenance_household ON maintenance_task(household_id);
CREATE INDEX idx_maintenance_asset ON maintenance_task(asset_id);
