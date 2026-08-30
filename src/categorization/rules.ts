import type { Rule } from "../types";
import type { CandidateTransaction } from "./types";

/**
 * Rule conditions/actions (PLAN.md §7). Stored as JSON in rule.conditions /
 * rule.actions. Rules are the first, deterministic, zero-cost layer of the
 * cascade (§6 layer 1) and always win over memory or the LLM.
 */

export type Condition =
  | { field: "merchant"; op: "equals" | "contains" | "regex"; value: string }
  | { field: "description"; op: "contains" | "regex"; value: string }
  | { field: "amount"; op: "gt" | "gte" | "lt" | "lte" | "eq"; value: number }
  | { field: "amount"; op: "between"; value: [number, number] }
  | { field: "accountType"; op: "equals"; value: string }
  | { field: "ownerUserId"; op: "equals"; value: string }
  | { field: "dayOfWeek"; op: "in"; value: number[] } // 0 = Sunday
  | { type: "and"; conditions: Condition[] }
  | { type: "or"; conditions: Condition[] };

export type Action =
  | { type: "setCategory"; categoryId: string }
  | { type: "addMemo"; memo: string }
  | { type: "tag"; tag: string }
  | { type: "split"; splits: Array<{ categoryId: string; percent?: number; amountCents?: number }> }
  | { type: "markTransfer" }
  | { type: "excludeFromBudget" }
  | { type: "neverAskAboutThis" };

function evaluateCondition(condition: Condition, txn: CandidateTransaction): boolean {
  if ("type" in condition) {
    if (condition.type === "and") return condition.conditions.every((c) => evaluateCondition(c, txn));
    return condition.conditions.some((c) => evaluateCondition(c, txn));
  }

  switch (condition.field) {
    case "merchant": {
      const merchant = (txn.merchant ?? "").toLowerCase();
      const value = condition.value.toLowerCase();
      if (condition.op === "equals") return merchant === value;
      if (condition.op === "contains") return merchant.includes(value);
      return new RegExp(condition.value, "i").test(txn.merchant ?? "");
    }
    case "description": {
      const description = txn.rawDescription.toLowerCase();
      if (condition.op === "contains") return description.includes(condition.value.toLowerCase());
      return new RegExp(condition.value, "i").test(txn.rawDescription);
    }
    case "amount": {
      const amount = txn.amountCents;
      switch (condition.op) {
        case "gt":
          return amount > condition.value;
        case "gte":
          return amount >= condition.value;
        case "lt":
          return amount < condition.value;
        case "lte":
          return amount <= condition.value;
        case "eq":
          return amount === condition.value;
        case "between":
          return amount >= condition.value[0] && amount <= condition.value[1];
      }
      return false;
    }
    case "accountType":
      return txn.accountType === condition.value;
    case "ownerUserId":
      return txn.ownerUserId === condition.value;
    case "dayOfWeek":
      return condition.value.includes(new Date(txn.postedAt).getUTCDay());
  }
}

export function ruleMatches(rule: Rule, txn: CandidateTransaction): boolean {
  if (!rule.enabled) return false;
  const conditions = JSON.parse(rule.conditions) as Condition;
  return evaluateCondition(conditions, txn);
}

export function ruleActions(rule: Rule): Action[] {
  return JSON.parse(rule.actions) as Action[];
}

/** Rules are evaluated in priority order (lower number = higher priority,
 * matching the household_id+priority index); first match wins. */
export function findMatchingRule(rules: Rule[], txn: CandidateTransaction): Rule | null {
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);
  return sorted.find((rule) => ruleMatches(rule, txn)) ?? null;
}

export function categoryFromRule(rule: Rule): string | null {
  const setCategory = ruleActions(rule).find((a): a is Extract<Action, { type: "setCategory" }> => a.type === "setCategory");
  return setCategory?.categoryId ?? null;
}
