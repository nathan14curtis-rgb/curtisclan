-- Manual flag on a transaction — a lightweight, purely visual marker
-- (distinct from category/verify) a household member can set to call a
-- row out, e.g. "disputed" or "needs follow-up." Color only; no meaning
-- is enforced beyond the fixed palette the dashboard offers.
ALTER TABLE "transaction" ADD COLUMN flag_color TEXT CHECK (flag_color IN ('red','orange','yellow','green','blue','purple'));
