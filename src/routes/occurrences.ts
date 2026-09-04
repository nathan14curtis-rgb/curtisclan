import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { getOccurrence, listOccurrences, unlinkOccurrence, updateOccurrence } from "../envelopes/occurrences";

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const occurrencesRoute = new Hono<{ Bindings: Env }>();

// What the Spending Plan reads: generate the month's occurrences from every
// confirmed series, reconcile them against what actually posted, and hand
// back the lot. Idempotent, so calling it on every page load is fine.
occurrencesRoute.get("/", async (c) => {
  const month = c.req.query("month");
  if (!month || !MONTH_RE.test(month)) return c.json({ error: "month query param must be 'YYYY-MM'" }, 400);
  const occurrences = await listOccurrences(c.env.DB, requireParam(c, "householdId"), month);
  return c.json(occurrences);
});

// One occurrence's own edits — this month's amount, a moved due date, or
// skipping it. None of these touch the series; that's /recurring-patterns.
occurrencesRoute.patch("/:occurrenceId", async (c) => {
  const body = await c.req.json<{ amountOverrideCents?: number | null; dueDate?: string; status?: string }>();

  if (body.amountOverrideCents !== undefined && body.amountOverrideCents !== null && !Number.isInteger(body.amountOverrideCents)) {
    return c.json({ error: "amountOverrideCents must be an integer number of cents, or null to clear it" }, 400);
  }
  if (body.dueDate !== undefined && !DATE_RE.test(body.dueDate)) {
    return c.json({ error: "dueDate must be 'YYYY-MM-DD'" }, 400);
  }
  if (body.status !== undefined && body.status !== "upcoming" && body.status !== "skipped") {
    // 'matched' is reconciliation's to set, never a client's — a person
    // links a transaction by categorizing it, not by asserting a status.
    return c.json({ error: "status must be 'upcoming' or 'skipped'" }, 400);
  }

  const existing = await getOccurrence(c.env.DB, requireParam(c, "householdId"), requireParam(c, "occurrenceId"));
  if (!existing) return c.json({ error: "occurrence not found" }, 404);

  const occurrence = await updateOccurrence(c.env.DB, requireParam(c, "householdId"), requireParam(c, "occurrenceId"), {
    ...("amountOverrideCents" in body ? { amountOverrideCents: body.amountOverrideCents } : {}),
    dueDate: body.dueDate,
    status: body.status as "upcoming" | "skipped" | undefined,
  });
  return c.json(occurrence);
});

// "Unlink transaction" — the posted transaction stops standing for this
// occurrence, and the pair is remembered so the next reconcile doesn't
// simply put them back together.
occurrencesRoute.post("/:occurrenceId/unlink", async (c) => {
  const existing = await getOccurrence(c.env.DB, requireParam(c, "householdId"), requireParam(c, "occurrenceId"));
  if (!existing) return c.json({ error: "occurrence not found" }, 404);
  const occurrence = await unlinkOccurrence(c.env.DB, requireParam(c, "householdId"), requireParam(c, "occurrenceId"));
  return c.json(occurrence);
});
