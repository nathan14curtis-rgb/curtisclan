import type { AccountType } from "../types";

/** What the cascade needs about a transaction. Deliberately not the full
 * D1 row — this is also what gets sent to Claude (PLAN.md §10: "What goes
 * to Claude: merchant, amount, date, category list, your reply text. Not
 * account numbers, not balances, not names."), so keeping this type
 * narrow is what makes that boundary enforceable in code, not just policy. */
export interface CandidateTransaction {
  id: string;
  merchant: string | null;
  rawDescription: string;
  amountCents: number;
  postedAt: string;
  accountType: AccountType;
  ownerUserId: string | null;
}

export type CascadeLayer = "rule" | "memory" | "llm" | "none";

export type CascadeResult =
  | { layer: "rule"; categoryId: string; ruleId: string; confidence: 1; needsClarification: false }
  | { layer: "memory"; categoryId: string; confidence: number; needsClarification: false }
  | {
      layer: "llm";
      categoryId: string;
      confidence: number;
      model: string;
      reasoning?: string;
      promptVersion?: string;
      needsClarification: boolean;
    }
  | { layer: "none"; categoryId: null; needsClarification: true };
