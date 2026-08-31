-- Session + login-code storage for phone-OTP login. Every household-scoped
-- API route now requires a valid session tied to that household (PLAN.md
-- §10 already called household data "the highest-consequence data you'll
-- ever own" — until now nothing actually enforced that). Login reuses the
-- existing phone-verification identity anchor (user.phone_e164 /
-- phone_verified_at, src/db/users.ts) as the credential: a one-time code
-- sent by text, same as the mechanism already trusted for inbound replies.
--
-- Secrets are hashed at rest, same reasoning as Plaid token encryption
-- elsewhere in this schema: a DB read alone must never hand out something
-- directly usable.

CREATE TABLE session (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  household_id  TEXT NOT NULL REFERENCES household(id),
  user_id       TEXT NOT NULL REFERENCES user(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_session_token_hash ON session(token_hash);
CREATE INDEX idx_session_household ON session(household_id);

CREATE TABLE login_code (
  id           TEXT PRIMARY KEY,
  phone_e164   TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  consumed_at  TEXT,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_login_code_phone ON login_code(phone_e164);
