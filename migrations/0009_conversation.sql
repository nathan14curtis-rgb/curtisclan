-- The texting bot stops being a reply-matcher and becomes a conversation.
-- A conversational agent (src/messaging/agent.ts) needs the thread it is
-- part of: "how much is left?" → "what about last month?" only works if
-- the second text can see the first. inbound_message already stores what
-- arrived, but nothing stored what the bot said back, and nothing put the
-- two in one ordered stream — that's this table.
--
-- Kept deliberately dumb: role + text + when, no tool-call transcript.
-- Tool results are re-derived from live data on the next turn, so
-- replaying a stale one would be worse than not having it.
CREATE TABLE conversation_message (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES household(id),
  -- Who sent it, for an inbound text from a specific spouse. Null for the
  -- assistant's own turns and for anything not attributable to a person.
  user_id      TEXT REFERENCES user(id),
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT NOT NULL,
  -- Where the turn happened: an iMessage reply, the dashboard chat box, or
  -- a message the bot sent on its own schedule (hourly ask, daily digest).
  channel      TEXT NOT NULL DEFAULT 'imessage' CHECK (channel IN ('imessage', 'dashboard', 'scheduled')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_conversation_message_household ON conversation_message(household_id, created_at);
