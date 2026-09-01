import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { createCategory, createEnvelopeForCategory } from "../db/categories";
import { confirmRecurringPattern, detectRecurringPatterns, dismissRecurringPattern, listRecurringPatterns } from "../db/recurringPatterns";

export const recurringPatternsRoute = new Hono<{ Bindings: Env }>();

recurringPatternsRoute.get("/", async (c) => {
  const status = c.req.query("status");
  const patterns = await listRecurringPatterns(c.env.DB, requireParam(c, "householdId"), {
    status: status === "suggested" || status === "confirmed" || status === "dismissed" ? status : undefined,
  });
  return c.json(patterns);
});

// Manual trigger for "or manually" — the same detector Plaid sync runs
// automatically (src/plaid/sync.ts), exposed for the Recurring page's
// "suggest bills" action.
recurringPatternsRoute.post("/detect", async (c) => {
  const created = await detectRecurringPatterns(c.env.DB, requireParam(c, "householdId"));
  return c.json(created, 201);
});

// Confirming a suggestion needs a category to file future matches under —
// either an existing one (categoryId) or a brand-new one created on the
// spot (newCategoryName), the same category+envelope pairing
// routes/categories.ts's POST / does for a manually-added bill.
recurringPatternsRoute.post("/:patternId/confirm", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ categoryId?: string; newCategoryName?: string; kind?: "expense" | "income" }>();

  let categoryId = body.categoryId;
  if (!categoryId) {
    if (!body.newCategoryName?.trim()) return c.json({ error: "categoryId or newCategoryName is required" }, 400);
    if (body.kind !== "expense" && body.kind !== "income") return c.json({ error: "kind ('expense' or 'income') is required with newCategoryName" }, 400);
    const category = await createCategory(c.env.DB, householdId, { name: body.newCategoryName.trim(), kind: body.kind });
    if (category.kind === "expense") {
      await createEnvelopeForCategory(c.env.DB, householdId, category, { groupName: "Bills" });
    }
    categoryId = category.id;
  }

  const pattern = await confirmRecurringPattern(c.env.DB, householdId, requireParam(c, "patternId"), categoryId);
  return c.json(pattern);
});

recurringPatternsRoute.post("/:patternId/dismiss", async (c) => {
  await dismissRecurringPattern(c.env.DB, requireParam(c, "householdId"), requireParam(c, "patternId"));
  return c.json({ ok: true });
});
