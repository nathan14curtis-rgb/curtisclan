-- Route the iMessage loop to one household-level group chat instead of
-- per-account-owner 1:1 texts. Sendblue's group API hands back a group_id
-- the first time you message a set of numbers; every later message reuses
-- it to stay in the same thread (PLAN.md §5, extended per household
-- request: "wire it so all transactions go to a group chat with my wife
-- and I" — this also answers §13 Q6, "ask a default, or ask both?", with
-- a third option: ask everyone at once, in one thread).
ALTER TABLE household ADD COLUMN group_chat_id TEXT;
