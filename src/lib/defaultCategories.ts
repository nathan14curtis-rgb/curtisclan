import type { CategoryKind } from "../types";

/**
 * Starting taxonomy for a new household. Expense/savings entries get an
 * envelope automatically (PLAN.md §3, §8); income/transfer entries never do.
 *
 * This is a reasonable default, not a re-creation of any specific Simplifi
 * export — PLAN.md §12 Phase 0 calls for exporting the real Simplifi
 * taxonomy so history maps cleanly, but that export is data only you have
 * (§13 Q7/Q8). Bring it in through the same CSV import path used for
 * transaction history, or edit these in the dashboard once built.
 */
export interface DefaultCategory {
  name: string;
  kind: CategoryKind;
  group?: string; // envelope.group_name, expense/savings only
  monthlyTargetCents?: number;
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  // Housing
  { name: "Rent/Mortgage", kind: "expense", group: "Housing" },
  { name: "Utilities", kind: "expense", group: "Housing" },
  { name: "Home Maintenance", kind: "expense", group: "Housing" },

  // Food
  { name: "Groceries", kind: "expense", group: "Food" },
  { name: "Dining Out", kind: "expense", group: "Food" },

  // Transportation
  { name: "Gas", kind: "expense", group: "Transportation" },
  { name: "Auto Maintenance", kind: "expense", group: "Transportation" },
  { name: "Parking & Tolls", kind: "expense", group: "Transportation" },

  // Insurance
  { name: "Health Insurance", kind: "expense", group: "Insurance" },
  { name: "Auto Insurance", kind: "expense", group: "Insurance" },

  // Personal
  { name: "Clothing", kind: "expense", group: "Personal" },
  { name: "Personal Care", kind: "expense", group: "Personal" },
  { name: "Subscriptions", kind: "expense", group: "Personal" },

  // Entertainment
  { name: "Entertainment", kind: "expense", group: "Entertainment" },
  { name: "Hobbies", kind: "expense", group: "Entertainment" },

  // Health
  { name: "Medical", kind: "expense", group: "Health" },
  { name: "Pharmacy", kind: "expense", group: "Health" },

  // Giving
  { name: "Gifts", kind: "expense", group: "Giving" },
  { name: "Charity", kind: "expense", group: "Giving" },

  // Everything else
  { name: "Miscellaneous", kind: "expense", group: "Other" },

  // Savings goals — same envelope mechanics as expenses (PLAN §8.5)
  { name: "Emergency Fund", kind: "savings", group: "Savings Goals" },
  { name: "Vacation Fund", kind: "savings", group: "Savings Goals" },

  // Income — lands in Ready to Assign, never funded (PLAN §3, §8.4)
  { name: "Paycheck", kind: "income" },
  { name: "Other Income", kind: "income" },

  // Transfers — excluded from budget entirely (PLAN §3, §8.3)
  { name: "Credit Card Payment", kind: "transfer" },
  { name: "Account Transfer", kind: "transfer" },
];
