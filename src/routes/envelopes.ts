import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { Env } from "../types";
import { allocateToEnvelope, getEnvelopeMonthSummary, listEnvelopes, moveMoneyBetweenEnvelopes } from "../db/envelopes";

const MONTH_RE = /^\d{4}-\d{2}$/;

export const envelopesRoute = new Hono<{ Bindings: Env }>();

envelopesRoute.get("/", async (c) => {
  const envelopes = await listEnvelopes(c.env.DB, requireParam(c, "householdId"));
  return c.json(envelopes);
});

envelopesRoute.get("/:envelopeId/summary", async (c) => {
  const month = c.req.query("month");
  if (!month || !MONTH_RE.test(month)) return c.json({ error: "month query param must be 'YYYY-MM'" }, 400);
  const summary = await getEnvelopeMonthSummary(c.env.DB, requireParam(c, "householdId"), requireParam(c, "envelopeId"), month);
  return c.json(summary);
});

envelopesRoute.post("/:envelopeId/allocate", async (c) => {
  const body = await c.req.json<{ month?: string; amountCents?: number; note?: string; createdByUserId?: string }>();
  if (!body.month || !MONTH_RE.test(body.month)) return c.json({ error: "month must be 'YYYY-MM'" }, 400);
  if (!Number.isInteger(body.amountCents)) return c.json({ error: "amountCents must be an integer" }, 400);

  await allocateToEnvelope(c.env.DB, requireParam(c, "householdId"), {
    envelopeId: requireParam(c, "envelopeId"),
    month: body.month,
    amountCents: body.amountCents!,
    note: body.note,
    createdByUserId: body.createdByUserId,
  });
  return c.json({ ok: true }, 201);
});

// First-class, audited move between two envelopes (PLAN §8.1) — e.g.
// covering an overspent envelope from another one.
envelopesRoute.post("/move", async (c) => {
  const body = await c.req.json<{
    fromEnvelopeId?: string;
    toEnvelopeId?: string;
    month?: string;
    amountCents?: number;
    note?: string;
    createdByUserId?: string;
  }>();
  if (!body.fromEnvelopeId || !body.toEnvelopeId) {
    return c.json({ error: "fromEnvelopeId and toEnvelopeId are required" }, 400);
  }
  if (!body.month || !MONTH_RE.test(body.month)) return c.json({ error: "month must be 'YYYY-MM'" }, 400);
  if (!Number.isInteger(body.amountCents) || (body.amountCents ?? 0) <= 0) {
    return c.json({ error: "amountCents must be a positive integer" }, 400);
  }

  await moveMoneyBetweenEnvelopes(c.env.DB, requireParam(c, "householdId"), {
    fromEnvelopeId: body.fromEnvelopeId,
    toEnvelopeId: body.toEnvelopeId,
    month: body.month,
    amountCents: body.amountCents!,
    note: body.note,
    createdByUserId: body.createdByUserId,
  });
  return c.json({ ok: true }, 201);
});
