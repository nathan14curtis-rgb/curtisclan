-- Recurring bills/income aren't always monthly-on-one-day: a paycheck can
-- land every other week, a mortgage twice a month. 'monthly' (the only
-- shape before this migration) keeps using day_of_month exactly as before;
-- 'semimonthly' adds a second day_of_month_2 (e.g. the 8th and the 23rd);
-- 'weekly' uses day_of_week (0=Sunday..6=Saturday) instead, and
-- day_of_month on a weekly row is unused (kept NOT NULL for storage
-- simplicity, ignored by matching — see src/db/recurringPatterns.ts).
ALTER TABLE recurring_pattern ADD COLUMN frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly', 'semimonthly', 'monthly'));
ALTER TABLE recurring_pattern ADD COLUMN day_of_month_2 INTEGER;
ALTER TABLE recurring_pattern ADD COLUMN day_of_week INTEGER;
