import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { applyCategorization, getTransaction, listTransactions, splitTransaction } from "../db/transactions";
import { listClassifications } from "../db/classifications";
import { categorizeTransaction } from "../categorization/pipeline";

export const transactionsRoute = new Hono<{ Bindings: Env }>();

transactionsRoute.get("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const transactions = await listTransactions(c.env.DB, householdId, {
    accountId: c.req.query("accountId"),
    categoryId: c.req.query("categoryId"),
    fromDate: c.req.query("fromDate"),
    toDate: c.req.query("toDate"),
    needsReview: c.req.query("needsReview") === "true",
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
  });
  return c.json(transactions);
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
