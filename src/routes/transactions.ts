import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env, TransactionFlagColor } from "../types";
import {
  applyCategorization,
  clearCategorization,
  createTransaction,
  editTransaction,
  getTransaction,
  listTransactionsWithVerifyState,
  setTransactionExcluded,
  setTransactionFlag,
  splitTransaction,
  unverifyTransaction,
  verifyTransaction,
} from "../db/transactions";
import { listClassifications } from "../db/classifications";
import { categorizeTransaction } from "../categorization/pipeline";

export const transactionsRoute = new Hono<{ Bindings: Env }>();

transactionsRoute.get("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const transactions = await listTransactionsWithVerifyState(c.env.DB, householdId, {
    accountId: c.req.query("accountId"),
    categoryId: c.req.query("categoryId"),
    fromDate: c.req.query("fromDate"),
    toDate: c.req.query("toDate"),
    needsReview: c.req.query("needsReview") === "true",
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
  return c.json(transactions);
});

// Manually-added income (or any transaction) that never came from a bank
// feed — "add income manually" on the Spending Plan's Income tab. Created
// straight into source='manual' and, when a person is doing the adding,
// verified on the spot: they're not confirming a guess, they typed it.
transactionsRoute.post("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{
    accountId?: string;
    postedAt?: string;
    amountCents?: number;
    description?: string;
    categoryId?: string;
    memo?: string;
    createdByUserId?: string;
  }>();

  if (!body.accountId) return c.json({ error: "accountId is required" }, 400);
  if (!body.postedAt) return c.json({ error: "postedAt is required" }, 400);
  if (typeof body.amountCents !== "number" || body.amountCents === 0) return c.json({ error: "amountCents is required and must be non-zero" }, 400);
  if (!body.description?.trim()) return c.json({ error: "description is required" }, 400);
  if (!body.categoryId) return c.json({ error: "categoryId is required" }, 400);

  const transaction = await createTransaction(c.env.DB, householdId, {
    accountId: body.accountId,
    postedAt: body.postedAt,
    amountCents: body.amountCents,
    rawDescription: body.description.trim(),
    source: "manual",
  });

  const categorized = await applyCategorization(c.env.DB, householdId, transaction.id, {
    categoryId: body.categoryId,
    memo: body.memo,
    method: "human",
    createdByUserId: body.createdByUserId,
  });

  if (body.createdByUserId) {
    const verified = await verifyTransaction(c.env.DB, householdId, transaction.id, body.createdByUserId);
    return c.json(verified, 201);
  }
  return c.json(categorized, 201);
});

transactionsRoute.get("/:transactionId", async (c) => {
  const householdId = requireParam(c, "householdId");
  const transactionId = requireParam(c, "transactionId");
  const [transaction, classifications] = await Promise.all([
    getTransaction(c.env.DB, householdId, transactionId),
    listClassifications(c.env.DB, householdId, transactionId),
  ]);
  // Show *why* something was categorized — the audit trail is what makes
  // this trustworthy (PLAN.md §9).
  return c.json({ ...transaction, classifications });
});

// A manual dashboard edit is a first-class correction, identical in weight
// to a text reply (PLAN.md §9, §5.5) — this is the same write path
// (applyCategorization) the iMessage reply resolver will use in Phase 3.
transactionsRoute.patch("/:transactionId/categorize", async (c) => {
  const body = await c.req.json<{ categoryId?: string; memo?: string; createdByUserId?: string }>();
  if (!body.categoryId) return c.json({ error: "categoryId is required" }, 400);

  const transaction = await applyCategorization(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), {
    categoryId: body.categoryId,
    memo: body.memo,
    method: "human",
    createdByUserId: body.createdByUserId,
  });
  return c.json(transaction);
});

// Recovery path for a transaction that never got auto-categorized (stuck
// `categorize` queue job, or freshly added rule/merchant memory that
// should now match) — runs the cascade synchronously so any failure
// surfaces directly in the response and this request's own invocation
// log, instead of the queue's silent retry-then-drop.
transactionsRoute.post("/:transactionId/recategorize", async (c) => {
  const householdId = requireParam(c, "householdId");
  const transactionId = requireParam(c, "transactionId");
  await categorizeTransaction(c.env, householdId, transactionId);
  const transaction = await getTransaction(c.env.DB, householdId, transactionId);
  return c.json(transaction);
});

// The dashboard's pencil-edit flow: category and amount corrected and
// saved together in one write, which also verifies the row.
transactionsRoute.patch("/:transactionId/edit", async (c) => {
  const body = await c.req.json<{ categoryId?: string; amountCents?: number; editedByUserId?: string }>();
  if (!body.categoryId) return c.json({ error: "categoryId is required" }, 400);
  if (typeof body.amountCents !== "number") return c.json({ error: "amountCents is required" }, 400);

  const transaction = await editTransaction(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), {
    categoryId: body.categoryId,
    amountCents: body.amountCents,
    editedByUserId: body.editedByUserId,
  });
  return c.json(transaction);
});

const FLAG_COLORS = new Set<TransactionFlagColor>(["red", "orange", "yellow", "green", "blue", "purple"]);

// A purely visual marker, independent of category/verify/exclude.
transactionsRoute.post("/:transactionId/flag", async (c) => {
  const body = await c.req.json<{ color?: TransactionFlagColor | null }>();
  if (body.color != null && !FLAG_COLORS.has(body.color)) return c.json({ error: "invalid flag color" }, 400);
  const transaction = await setTransactionFlag(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), body.color ?? null);
  return c.json(transaction);
});

// A dashboard toggle, not a categorization — for a reimbursed purchase, a
// transfer the auto-detector missed, or anything else that shouldn't
// count against a budget without also erasing its category.
transactionsRoute.post("/:transactionId/exclude", async (c) => {
  const body = await c.req.json<{ excluded?: boolean }>();
  if (typeof body.excluded !== "boolean") return c.json({ error: "excluded must be a boolean" }, 400);
  const transaction = await setTransactionExcluded(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), body.excluded);
  return c.json(transaction);
});

// The teal-check "verified by you" mark — an explicit human confirmation,
// distinct from (and not implied by) categorizing a transaction.
transactionsRoute.post("/:transactionId/verify", async (c) => {
  const body = await c.req.json<{ verifiedByUserId?: string }>();
  if (!body.verifiedByUserId) return c.json({ error: "verifiedByUserId is required" }, 400);
  const transaction = await verifyTransaction(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), body.verifiedByUserId);
  return c.json(transaction);
});

transactionsRoute.post("/:transactionId/unverify", async (c) => {
  const transaction = await unverifyTransaction(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"));
  return c.json(transaction);
});

// The verify toggle's "off" side, for a transaction whose category was
// never actually confirmed by a person (verify_state 'ai') — resets it to
// uncategorized instead of leaving an unconfirmed guess on the record.
transactionsRoute.post("/:transactionId/uncategorize", async (c) => {
  const body = await c.req.json<{ clearedByUserId?: string }>().catch(() => ({}) as { clearedByUserId?: string });
  const transaction = await clearCategorization(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), body.clearedByUserId);
  return c.json(transaction);
});

transactionsRoute.post("/:transactionId/split", async (c) => {
  const body = await c.req.json<{ splits?: Array<{ amountCents: number; categoryId: string; memo?: string }> }>();
  if (!body.splits || body.splits.length < 2) {
    return c.json({ error: "splits must be an array of at least two { amountCents, categoryId }" }, 400);
  }

  try {
    const children = await splitTransaction(c.env.DB, requireParam(c, "householdId"), requireParam(c, "transactionId"), body.splits);
    return c.json(children, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "split failed" }, 400);
  }
});
