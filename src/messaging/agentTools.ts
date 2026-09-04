import type Anthropic from "@anthropic-ai/sdk";
import type { Category, Env, Envelope } from "../types";
import { listAccounts } from "../db/accounts";
import {
  archiveCategory,
  createCategory,
  createEnvelopeForCategory,
  listCategories,
  renameCategory,
} from "../db/categories";
import { getLatestClarificationForTransaction, listOpenClarificationsForHousehold, markClarificationAnswered } from "../db/clarifications";
import {
  allocateToEnvelope,
  getEnvelopeMonthSummariesForHousehold,
  listEnvelopes,
  moveMoneyBetweenEnvelopes,
  updateEnvelope,
} from "../db/envelopes";
import { listRecurringPatterns } from "../db/recurringPatterns";
import { createRule } from "../db/rules";
import { applyCategorization, getTransaction, listTransactions, setTransactionExcluded } from "../db/transactions";
import type { Condition } from "../categorization/rules";

/**
 * The tools the conversational bot (src/messaging/agent.ts) can call.
 *
 * Everything the household can do from the dashboard — look at any slice
 * of their data, recategorize a charge, retarget an envelope, move money,
 * add a category, start a goal — is reachable from a text message through
 * this list. Two rules hold the whole thing together:
 *
 *  1. Every tool is household-scoped by the context, never by an argument.
 *     The model cannot name a household; it only ever operates on the one
 *     whose thread it is answering in (PLAN.md §10).
 *  2. Every write goes through the same src/db helpers the HTTP routes
 *     use, so a text-message edit produces the same audit rows, the same
 *     merchant-memory reinforcement, and the same ledger entries as a
 *     dashboard edit. No tool writes SQL of its own.
 *
 * Amounts cross this boundary in dollars, not cents — the model reads and
 * writes what the person actually said ("$250"), and the conversion to
 * integer cents happens exactly once, here.
 */

export interface AgentToolContext {
  householdId: string;
  /** Who is talking, for attribution on writes. Null for the dashboard's
   * unauthenticated-in-agent-terms callers and scheduled runs. */
  userId: string | null;
}

interface AgentTool {
  definition: Anthropic.Tool;
  /** True for anything that changes stored data — used to summarize what a
   * turn actually did, and to keep read-only turns cheap to reason about. */
  mutates: boolean;
  run(env: Env, ctx: AgentToolContext, input: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function toDollars(cents: number): number {
  return Math.round(cents) / 100;
}

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key];
  return typeof value === "boolean" ? value : null;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === null) throw new AgentToolError(`'${key}' is required`);
  return value;
}

/** A tool failure the model is expected to read and recover from (a
 * category name that doesn't exist, an amount that doesn't parse) rather
 * than an internal fault. Surfaces as an is_error tool_result so the model
 * can correct itself in the same turn instead of the whole reply dying. */
export class AgentToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolError";
  }
}

/** Categories are addressed by name in conversation ("groceries"), by id
 * in the data. Accept either, and when neither matches, fail with the list
 * of real names so the model's next attempt can be right. */
async function resolveCategory(env: Env, householdId: string, nameOrId: string): Promise<Category> {
  const categories = await listCategories(env.DB, householdId);
  const byId = categories.find((c) => c.id === nameOrId);
  if (byId) return byId;
  const needle = nameOrId.trim().toLowerCase();
  const exact = categories.filter((c) => c.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  const partial = categories.filter((c) => c.name.toLowerCase().includes(needle) && !c.archived_at);
  if (partial.length === 1) return partial[0]!;
  const active = categories.filter((c) => !c.archived_at).map((c) => c.name);
  if (partial.length > 1) {
    throw new AgentToolError(`'${nameOrId}' matches more than one category (${partial.map((c) => c.name).join(", ")}) — use the exact name.`);
  }
  throw new AgentToolError(`No category named '${nameOrId}'. Existing categories: ${active.join(", ")}.`);
}

async function resolveEnvelope(env: Env, householdId: string, categoryNameOrId: string): Promise<{ category: Category; envelope: Envelope }> {
  const category = await resolveCategory(env, householdId, categoryNameOrId);
  const envelopes = await listEnvelopes(env.DB, householdId);
  const envelope = envelopes.find((e) => e.category_id === category.id);
  if (!envelope) {
    throw new AgentToolError(
      `'${category.name}' is a ${category.kind} category and has no envelope — only expense and savings categories hold money.`,
    );
  }
  return { category, envelope };
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const getSpendingPlan: AgentTool = {
  mutates: false,
  definition: {
    name: "get_spending_plan",
    description:
      "The household's whole spending plan for a month: every envelope with its group, monthly target (what they plan to spend), what they've actually spent this month, and the running balance carried through this month. Use this for any 'how much is left', 'are we over', 'what's the plan' question.",
    input_schema: {
      type: "object",
      properties: {
        month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const month = str(input, "month") ?? currentMonth();
    const [envelopes, categories, summaries] = await Promise.all([
      listEnvelopes(env.DB, ctx.householdId),
      listCategories(env.DB, ctx.householdId),
      getEnvelopeMonthSummariesForHousehold(env.DB, ctx.householdId, month),
    ]);
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    return {
      month,
      envelopes: envelopes
        .filter((e) => !e.archived_at)
        .map((e) => {
          const summary = summaries[e.id];
          return {
            category: categoryById.get(e.category_id)?.name ?? "?",
            category_id: e.category_id,
            group: e.group_name,
            planned_dollars: e.monthly_target_cents === null ? null : toDollars(e.monthly_target_cents),
            spent_dollars: toDollars(summary?.spentCents ?? 0),
            balance_dollars: toDollars(summary?.balanceCents ?? 0),
            goal_date: e.target_date,
          };
        }),
    };
  },
};

const listCategoriesTool: AgentTool = {
  mutates: false,
  definition: {
    name: "list_categories",
    description: "Every category in the household's taxonomy, with its kind (expense, income, savings, transfer) and whether it's archived.",
    input_schema: {
      type: "object",
      properties: { include_archived: { type: "boolean", description: "Defaults to false." } },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const includeArchived = bool(input, "include_archived") ?? false;
    const categories = await listCategories(env.DB, ctx.householdId);
    return {
      categories: categories
        .filter((c) => includeArchived || !c.archived_at)
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, archived: c.archived_at !== null })),
    };
  },
};

const searchTransactions: AgentTool = {
  mutates: false,
  definition: {
    name: "search_transactions",
    description:
      "Find transactions. Every filter is optional and they combine. Use this to answer questions about specific charges ('what did we spend at Costco last month?') and to find the transaction id you need before recategorizing something.",
    input_schema: {
      type: "object",
      properties: {
        merchant_contains: { type: "string", description: "Case-insensitive substring of the merchant or the raw bank description." },
        category: { type: "string", description: "Category name or id to filter to." },
        from_date: { type: "string", description: "'YYYY-MM-DD', inclusive. Defaults to 90 days ago." },
        to_date: { type: "string", description: "'YYYY-MM-DD', inclusive." },
        uncategorized_only: { type: "boolean", description: "Only transactions with no category yet." },
        min_amount_dollars: { type: "number", description: "Absolute dollar amount — 50 means '$50 or larger', whether spend or income." },
        limit: { type: "number", description: "Defaults to 25, max 100." },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const categoryName = str(input, "category");
    const category = categoryName ? await resolveCategory(env, ctx.householdId, categoryName) : null;
    const limit = Math.min(num(input, "limit") ?? 25, 100);
    const merchant = str(input, "merchant_contains")?.toLowerCase() ?? null;
    const minAmount = num(input, "min_amount_dollars");

    const transactions = await listTransactions(env.DB, ctx.householdId, {
      categoryId: category?.id,
      fromDate: str(input, "from_date") ?? isoDaysAgo(90),
      toDate: str(input, "to_date") ?? undefined,
      needsReview: bool(input, "uncategorized_only") ?? undefined,
      // Over-fetch, because merchant/amount filtering happens in memory
      // below (a LIKE on two columns plus an ABS comparison isn't worth a
      // new query shape in src/db/transactions.ts for this one caller).
      limit: merchant || minAmount !== null ? 500 : limit,
    });
    const categories = await listCategories(env.DB, ctx.householdId);
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));

    const matched = transactions
      .filter((t) => {
        if (merchant && !`${t.normalized_merchant ?? ""} ${t.raw_description}`.toLowerCase().includes(merchant)) return false;
        if (minAmount !== null && Math.abs(t.amount_cents) < toCents(minAmount)) return false;
        return true;
      })
      .slice(0, limit);

    return {
      count: matched.length,
      total_dollars: toDollars(matched.reduce((sum, t) => sum + t.amount_cents, 0)),
      transactions: matched.map((t) => ({
        transaction_id: t.id,
        date: t.posted_at,
        merchant: t.normalized_merchant ?? t.raw_description,
        amount_dollars: toDollars(t.amount_cents),
        category: t.category_id ? (categoryById.get(t.category_id) ?? null) : null,
        memo: t.memo,
        pending: t.pending === 1,
        excluded_from_budget: t.excluded_from_budget === 1,
      })),
    };
  },
};

const spendingSummary: AgentTool = {
  mutates: false,
  definition: {
    name: "spending_summary",
    description:
      "Totals by category over a date range — the fastest way to answer 'where did the money go', 'how much did we spend on X in June', or 'compare this month to last'. Transfers and anything excluded from the budget are left out.",
    input_schema: {
      type: "object",
      properties: {
        from_date: { type: "string", description: "'YYYY-MM-DD', inclusive. Defaults to the start of the current month." },
        to_date: { type: "string", description: "'YYYY-MM-DD', inclusive. Defaults to today." },
      },
      required: [],
    },
  },
  async run(env, ctx, input) {
    const fromDate = str(input, "from_date") ?? `${currentMonth()}-01`;
    const toDate = str(input, "to_date") ?? new Date().toISOString().slice(0, 10);
    const { results } = await env.DB.prepare(
      `SELECT t.category_id AS category_id, COUNT(*) AS txn_count, COALESCE(SUM(t.amount_cents), 0) AS total
         FROM "transaction" t
        WHERE t.household_id = ? AND t.is_transfer = 0 AND t.excluded_from_budget = 0
          AND t.posted_at >= ? AND t.posted_at <= ?
        GROUP BY t.category_id`,
    )
      .bind(ctx.householdId, fromDate, toDate)
      .all<{ category_id: string | null; txn_count: number; total: number }>();

    const categories = await listCategories(env.DB, ctx.householdId);
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const rows = results
      .map((r) => {
        const category = r.category_id ? categoryById.get(r.category_id) : null;
        return {
          category: category?.name ?? "Uncategorized",
          kind: category?.kind ?? "unknown",
          // Spend is stored negative; report it as a positive "spent" number.
          amount_dollars: toDollars(-r.total),
          transaction_count: r.txn_count,
        };
      })
      .sort((a, b) => b.amount_dollars - a.amount_dollars);

    const spent = rows.filter((r) => r.kind !== "income").reduce((sum, r) => sum + r.amount_dollars, 0);
    const income = rows.filter((r) => r.kind === "income").reduce((sum, r) => sum - r.amount_dollars, 0);
    return { from_date: fromDate, to_date: toDate, total_spent_dollars: Math.round(spent * 100) / 100, total_income_dollars: Math.round(income * 100) / 100, by_category: rows };
  },
};

const listAccountsTool: AgentTool = {
  mutates: false,
  definition: {
    name: "list_accounts",
    description: "The household's linked bank and credit card accounts with their latest known balances.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(env, ctx) {
    const accounts = await listAccounts(env.DB, ctx.householdId);
    return {
      accounts: accounts.map((a) => ({
        name: a.name,
        type: a.type,
        mask: a.mask,
        status: a.status,
        balance_dollars: a.current_balance_cents === null ? null : toDollars(a.current_balance_cents),
        balance_updated_at: a.balance_updated_at,
      })),
    };
  },
};

const listRecurringBills: AgentTool = {
  mutates: false,
  definition: {
    name: "list_recurring_bills",
    description: "Recurring bills and income the app has detected or the household has confirmed, with how often each lands.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(env, ctx) {
    const patterns = await listRecurringPatterns(env.DB, ctx.householdId);
    const categories = await listCategories(env.DB, ctx.householdId);
    const categoryById = new Map(categories.map((c) => [c.id, c.name]));
    return {
      patterns: patterns.map((p) => ({
        merchant: p.merchant_pattern,
        kind: p.kind,
        frequency: p.frequency,
        day_of_month: p.day_of_month,
        day_of_week: p.day_of_week,
        status: p.status,
        category: p.category_id ? (categoryById.get(p.category_id) ?? null) : null,
      })),
    };
  },
};

const getOpenQuestions: AgentTool = {
  mutates: false,
  definition: {
    name: "get_open_questions",
    description:
      "The charges currently waiting on an answer from the household — the ones the bot has asked about and nobody has categorized yet. Use this when a reply refers to something you asked ('the first one was groceries') and the ids aren't already in front of you.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  async run(env, ctx) {
    const open = await listOpenClarificationsForHousehold(env.DB, ctx.householdId);
    const items = await Promise.all(
      open.map(async (c) => {
        try {
          const t = await getTransaction(env.DB, ctx.householdId, c.transaction_id);
          return {
            transaction_id: t.id,
            date: t.posted_at,
            merchant: t.normalized_merchant ?? t.raw_description,
            amount_dollars: toDollars(t.amount_cents),
            asked_at: c.sent_at,
          };
        } catch {
          return null; // clarification pointing at a removed transaction
        }
      }),
    );
    return { open_questions: items.filter((i) => i !== null) };
  },
};

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

const categorizeTransactions: AgentTool = {
  mutates: true,
  definition: {
    name: "categorize_transactions",
    description:
      "File one or more transactions under a category. This is how a reply like 'the walmart one was groceries' actually lands. Marks the charge human-categorized, closes any open question about it, and teaches the merchant for next time — so only call it when the person actually told you what something was.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "One entry per transaction being categorized.",
          items: {
            type: "object",
            properties: {
              transaction_id: { type: "string" },
              category: { type: "string", description: "Category name or id." },
              memo: { type: "string", description: "What the person said this was, in their words — stored on the charge." },
            },
            required: ["transaction_id", "category"],
          },
        },
      },
      required: ["items"],
    },
  },
  async run(env, ctx, input) {
    const items = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]) : [];
    if (items.length === 0) throw new AgentToolError("'items' must contain at least one transaction to categorize");

    const applied: unknown[] = [];
    for (const item of items) {
      const transactionId = required(item, "transaction_id");
      const category = await resolveCategory(env, ctx.householdId, required(item, "category"));
      const transaction = await getTransaction(env.DB, ctx.householdId, transactionId);

      await applyCategorization(env.DB, ctx.householdId, transactionId, {
        categoryId: category.id,
        memo: str(item, "memo"),
        method: "human",
        createdByUserId: ctx.userId,
      });

      const clarification = await getLatestClarificationForTransaction(env.DB, ctx.householdId, transactionId);
      if (clarification && (clarification.status === "sent" || clarification.status === "queued")) {
        await markClarificationAnswered(env.DB, clarification.id);
      }

      applied.push({
        transaction_id: transactionId,
        merchant: transaction.normalized_merchant ?? transaction.raw_description,
        amount_dollars: toDollars(transaction.amount_cents),
        category: category.name,
      });
    }
    return { categorized: applied };
  },
};

const updateSpendingPlan: AgentTool = {
  mutates: true,
  definition: {
    name: "update_spending_plan",
    description:
      "Change what an existing envelope plans for: its monthly target, the group it shows up under, or its goal date. Setting a goal date turns an envelope into a savings goal ('$5,000 for a trip by next June' = a target date plus the monthly target that gets there). Omit a field to leave it alone.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "The envelope's category, by name or id." },
        monthly_target_dollars: { type: "number", description: "What they plan to put toward this every month." },
        clear_monthly_target: { type: "boolean", description: "True to remove the monthly target entirely." },
        group: { type: "string", description: "The group it's shown under on the dashboard, e.g. 'Bills', 'Everyday', 'Goals'." },
        goal_date: { type: "string", description: "'YYYY-MM-DD' the goal should be funded by." },
        clear_goal_date: { type: "boolean", description: "True to drop the goal date, leaving a plain envelope." },
      },
      required: ["category"],
    },
  },
  async run(env, ctx, input) {
    const { category, envelope } = await resolveEnvelope(env, ctx.householdId, required(input, "category"));
    const patch: { groupName?: string; monthlyTargetCents?: number | null; targetDate?: string | null } = {};
    const monthlyTarget = num(input, "monthly_target_dollars");
    if (bool(input, "clear_monthly_target")) patch.monthlyTargetCents = null;
    else if (monthlyTarget !== null) patch.monthlyTargetCents = toCents(monthlyTarget);
    if (bool(input, "clear_goal_date")) patch.targetDate = null;
    else if (str(input, "goal_date")) patch.targetDate = str(input, "goal_date");
    const group = str(input, "group");
    if (group) patch.groupName = group;

    const updated = await updateEnvelope(env.DB, ctx.householdId, envelope.id, patch);
    return {
      category: category.name,
      group: updated.group_name,
      monthly_target_dollars: updated.monthly_target_cents === null ? null : toDollars(updated.monthly_target_cents),
      goal_date: updated.target_date,
    };
  },
};

const createCategoryTool: AgentTool = {
  mutates: true,
  definition: {
    name: "create_category",
    description:
      "Add a new category to the spending plan. Expense and savings categories automatically get an envelope, so this is also how a new savings goal gets started. Check list_categories first — don't create a near-duplicate of one that already exists.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        kind: { type: "string", enum: ["expense", "savings", "income"], description: "savings for goals and sinking funds, income for paychecks." },
        group: { type: "string", description: "Dashboard group, e.g. 'Bills', 'Everyday', 'Goals'." },
        monthly_target_dollars: { type: "number" },
        goal_date: { type: "string", description: "'YYYY-MM-DD', for a savings goal with a deadline." },
      },
      required: ["name", "kind"],
    },
  },
  async run(env, ctx, input) {
    const name = required(input, "name");
    const kind = required(input, "kind");
    if (kind !== "expense" && kind !== "savings" && kind !== "income") {
      throw new AgentToolError("'kind' must be one of: expense, savings, income");
    }
    const existing = await listCategories(env.DB, ctx.householdId);
    if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase() && !c.archived_at)) {
      throw new AgentToolError(`A category named '${name}' already exists — use update_spending_plan to change it instead.`);
    }

    const category = await createCategory(env.DB, ctx.householdId, { name, kind });
    if (kind === "expense" || kind === "savings") {
      const monthlyTarget = num(input, "monthly_target_dollars");
      await createEnvelopeForCategory(env.DB, ctx.householdId, category, {
        groupName: str(input, "group") ?? (kind === "savings" ? "Goals" : "Uncategorized"),
        monthlyTargetCents: monthlyTarget === null ? null : toCents(monthlyTarget),
        targetDate: str(input, "goal_date"),
      });
    }
    return { created: { category: category.name, kind: category.kind, category_id: category.id } };
  },
};

const renameCategoryTool: AgentTool = {
  mutates: true,
  definition: {
    name: "rename_category",
    description: "Rename an existing category. Its history, envelope and balances all follow the rename.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string", description: "Current name or id." }, new_name: { type: "string" } },
      required: ["category", "new_name"],
    },
  },
  async run(env, ctx, input) {
    const category = await resolveCategory(env, ctx.householdId, required(input, "category"));
    const renamed = await renameCategory(env.DB, ctx.householdId, category.id, required(input, "new_name"));
    return { renamed: { from: category.name, to: renamed.name } };
  },
};

const archiveCategoryTool: AgentTool = {
  mutates: true,
  definition: {
    name: "archive_category",
    description:
      "Retire a category (and its envelope) from the spending plan. Nothing is deleted — past transactions keep their history — it just stops being offered for new charges. Confirm with the person before calling this.",
    input_schema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] },
  },
  async run(env, ctx, input) {
    const category = await resolveCategory(env, ctx.householdId, required(input, "category"));
    await archiveCategory(env.DB, ctx.householdId, category.id);
    return { archived: category.name };
  },
};

const moveMoney: AgentTool = {
  mutates: true,
  definition: {
    name: "move_money",
    description:
      "Move money from one envelope to another — 'take $50 from dining and put it in gas'. Records both sides as one reversible pair of ledger entries.",
    input_schema: {
      type: "object",
      properties: {
        from_category: { type: "string" },
        to_category: { type: "string" },
        amount_dollars: { type: "number", description: "A positive amount." },
        month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." },
        note: { type: "string", description: "Why, in the person's words." },
      },
      required: ["from_category", "to_category", "amount_dollars"],
    },
  },
  async run(env, ctx, input) {
    const amount = num(input, "amount_dollars");
    if (amount === null || amount <= 0) throw new AgentToolError("'amount_dollars' must be a positive number");
    const from = await resolveEnvelope(env, ctx.householdId, required(input, "from_category"));
    const to = await resolveEnvelope(env, ctx.householdId, required(input, "to_category"));
    if (from.envelope.id === to.envelope.id) throw new AgentToolError("from_category and to_category are the same envelope");

    const month = str(input, "month") ?? currentMonth();
    await moveMoneyBetweenEnvelopes(env.DB, ctx.householdId, {
      fromEnvelopeId: from.envelope.id,
      toEnvelopeId: to.envelope.id,
      month,
      amountCents: toCents(amount),
      note: str(input, "note"),
      createdByUserId: ctx.userId,
    });
    return { moved_dollars: amount, from: from.category.name, to: to.category.name, month };
  },
};

const assignMoney: AgentTool = {
  mutates: true,
  definition: {
    name: "assign_money",
    description:
      "Put money into an envelope for a month — funding a category from income, or topping one up. Use move_money instead when it's coming out of another envelope.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string" },
        amount_dollars: { type: "number", description: "Positive to add, negative to take back out." },
        month: { type: "string", description: "'YYYY-MM'. Defaults to the current month." },
        note: { type: "string" },
      },
      required: ["category", "amount_dollars"],
    },
  },
  async run(env, ctx, input) {
    const amount = num(input, "amount_dollars");
    if (amount === null || amount === 0) throw new AgentToolError("'amount_dollars' must be a non-zero number");
    const { category, envelope } = await resolveEnvelope(env, ctx.householdId, required(input, "category"));
    const month = str(input, "month") ?? currentMonth();
    await allocateToEnvelope(env.DB, ctx.householdId, {
      envelopeId: envelope.id,
      month,
      amountCents: toCents(amount),
      note: str(input, "note"),
      createdByUserId: ctx.userId,
    });
    return { assigned_dollars: amount, category: category.name, month };
  },
};

const setExcluded: AgentTool = {
  mutates: true,
  definition: {
    name: "set_transaction_excluded",
    description:
      "Keep a transaction on the books but out of every budget total — a reimbursed purchase, a transfer the detector missed, a duplicate the bank later refunded.",
    input_schema: {
      type: "object",
      properties: { transaction_id: { type: "string" }, excluded: { type: "boolean" } },
      required: ["transaction_id", "excluded"],
    },
  },
  async run(env, ctx, input) {
    const excluded = bool(input, "excluded");
    if (excluded === null) throw new AgentToolError("'excluded' must be true or false");
    const transaction = await setTransactionExcluded(env.DB, ctx.householdId, required(input, "transaction_id"), excluded);
    return { transaction_id: transaction.id, merchant: transaction.normalized_merchant ?? transaction.raw_description, excluded };
  },
};

const rememberMerchant: AgentTool = {
  mutates: true,
  definition: {
    name: "always_categorize_merchant",
    description:
      "Make a standing rule: every future charge whose merchant contains this text goes straight to this category, no question asked. Use it when someone says 'always file X as Y' or 'stop asking about X'. Categorizing a single charge already teaches the merchant on its own — only make a rule when they asked for one.",
    input_schema: {
      type: "object",
      properties: {
        merchant_contains: { type: "string", description: "Substring matched case-insensitively against the merchant name." },
        category: { type: "string" },
      },
      required: ["merchant_contains", "category"],
    },
  },
  async run(env, ctx, input) {
    const merchant = required(input, "merchant_contains");
    const category = await resolveCategory(env, ctx.householdId, required(input, "category"));
    const conditions: Condition = { field: "merchant", op: "contains", value: merchant };
    await createRule(env.DB, ctx.householdId, {
      conditions,
      actions: [{ type: "setCategory", categoryId: category.id }],
      source: "user",
    });
    return { rule: `merchant contains '${merchant}' → ${category.name}` };
  },
};

// ---------------------------------------------------------------------------

const TOOLS: AgentTool[] = [
  getSpendingPlan,
  listCategoriesTool,
  searchTransactions,
  spendingSummary,
  listAccountsTool,
  listRecurringBills,
  getOpenQuestions,
  categorizeTransactions,
  updateSpendingPlan,
  createCategoryTool,
  renameCategoryTool,
  archiveCategoryTool,
  moveMoney,
  assignMoney,
  setExcluded,
  rememberMerchant,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.definition.name, t]));

export const AGENT_TOOL_DEFINITIONS: Anthropic.Tool[] = TOOLS.map((t) => t.definition);

export function isMutatingTool(name: string): boolean {
  return TOOLS_BY_NAME.get(name)?.mutates ?? false;
}

export interface AgentToolOutcome {
  content: string;
  isError: boolean;
}

/**
 * Runs one tool call and returns the tool_result body. Never throws: a bad
 * argument comes back as an is_error result the model reads and retries,
 * and an unexpected fault comes back the same way rather than killing the
 * turn — a half-answered text is worse than one that says what went wrong.
 */
export async function runAgentTool(env: Env, ctx: AgentToolContext, name: string, input: unknown): Promise<AgentToolOutcome> {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) return { content: `No such tool '${name}'.`, isError: true };

  try {
    const result = await tool.run(env, ctx, (input ?? {}) as Record<string, unknown>);
    return { content: JSON.stringify(result), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true };
  }
}
