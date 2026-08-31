import type { Condition } from "./rules";
import { getDefaultIncomeCategory } from "../db/categories";
import { createRule, listRules } from "../db/rules";
import type { Rule } from "../types";

/**
 * Every candidate-category list in this codebase (the cascade, the text-
 * reply matcher, the dashboard's dropdown) used to filter to expense/
 * savings only — meaning a paycheck deposit had no automatic path to a
 * category at all: it either sat uncategorized forever, silently
 * corrupted an expense envelope's totals if the LLM force-fit it into one,
 * or texted someone asking "what was this $4,710 deposit?" for every
 * paycheck. Rules already support exactly this shape ("amount" conditions,
 * PLAN.md §7) — this seeds one instead of inventing a new mechanism:
 * amount > 0, low priority (so any household-authored rule — e.g. one
 * distinguishing "Paycheck" from "Other Income" by merchant — matches
 * first and wins), sets the household's default income category.
 *
 * Deliberately does not special-case refunds (also positive-amount):
 * PLAN.md §3 says a refund should net against its original expense
 * category, not get treated as income, but detecting "this positive
 * amount is a refund of that earlier expense" is real work this rule
 * doesn't attempt. A refund lands as income by default and gets
 * recategorized by hand — an accepted, deliberate simplification, not an
 * oversight.
 */
const LOW_PRIORITY = 900;

function isDefaultIncomeRuleCondition(conditions: string): boolean {
  try {
    const parsed = JSON.parse(conditions) as Condition;
    return "field" in parsed && parsed.field === "amount" && parsed.op === "gt" && parsed.value === 0;
  } catch {
    return false;
  }
}

/** Idempotent — safe to call on every sync. Returns the existing or
 * newly-created rule, or null if the household has no income category to
 * point it at (e.g. every income category got archived). */
export async function ensureDefaultIncomeRule(db: D1Database, householdId: string): Promise<Rule | null> {
  const existingRules = await listRules(db, householdId);
  const existing = existingRules.find((r) => isDefaultIncomeRuleCondition(r.conditions));
  if (existing) return existing;

  const incomeCategory = await getDefaultIncomeCategory(db, householdId);
  if (!incomeCategory) return null;

  return createRule(db, householdId, {
    priority: LOW_PRIORITY,
    conditions: { field: "amount", op: "gt", value: 0 },
    actions: [{ type: "setCategory", categoryId: incomeCategory.id }],
    source: "user",
  });
}
