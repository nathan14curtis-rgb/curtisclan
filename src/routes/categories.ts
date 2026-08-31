import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { CategoryKind, Env } from "../types";
import { archiveCategory, createCategory, createEnvelopeForCategory, listCategories, renameCategory, unarchiveCategory } from "../db/categories";

const CATEGORY_KINDS: CategoryKind[] = ["expense", "income", "savings", "transfer"];

export const categoriesRoute = new Hono<{ Bindings: Env }>();

categoriesRoute.get("/", async (c) => {
  const categories = await listCategories(c.env.DB, requireParam(c, "householdId"));
  return c.json(categories);
});

categoriesRoute.post("/", async (c) => {
  const body = await c.req.json<{
    name?: string;
    kind?: string;
    parentId?: string;
    groupName?: string;
    monthlyTargetCents?: number;
    targetDate?: string;
  }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.kind || !CATEGORY_KINDS.includes(body.kind as CategoryKind)) {
    return c.json({ error: `kind must be one of ${CATEGORY_KINDS.join(", ")}` }, 400);
  }

  const householdId = requireParam(c, "householdId");
  const category = await createCategory(c.env.DB, householdId, {
    name: body.name,
    kind: body.kind as CategoryKind,
    parentId: body.parentId,
  });

  // Expense/savings categories are envelopes (PLAN §3) — created together
  // so "an envelope you create here is immediately available as an answer
  // over text" (§9) instead of a second setup step.
  if (category.kind === "expense" || category.kind === "savings") {
    const envelope = await createEnvelopeForCategory(c.env.DB, householdId, category, {
      groupName: body.groupName,
      monthlyTargetCents: body.monthlyTargetCents ?? null,
      targetDate: body.targetDate ?? null,
    });
    return c.json({ category, envelope }, 201);
  }

  return c.json({ category, envelope: null }, 201);
});

// Rename only — kind can't change after creation (renameCategory's doc
// comment explains why); use archive + create-new for that.
categoriesRoute.patch("/:categoryId", async (c) => {
  const body = await c.req.json<{ name?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const category = await renameCategory(c.env.DB, requireParam(c, "householdId"), requireParam(c, "categoryId"), body.name);
  return c.json(category);
});

categoriesRoute.post("/:categoryId/archive", async (c) => {
  const category = await archiveCategory(c.env.DB, requireParam(c, "householdId"), requireParam(c, "categoryId"));
  return c.json(category);
});

categoriesRoute.post("/:categoryId/unarchive", async (c) => {
  const category = await unarchiveCategory(c.env.DB, requireParam(c, "householdId"), requireParam(c, "categoryId"));
  return c.json(category);
});
