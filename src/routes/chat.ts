import { Hono } from "hono";
import { requireParam } from "../lib/http";
import { listRecentConversation } from "../db/conversations";
import { runAgentTurn } from "../messaging/agent";
import type { Env } from "../types";

export const chatRoute = new Hono<{ Bindings: Env }>();

/**
 * The same conversation the household has by text, reachable from the
 * dashboard. Not a second bot: one agent, one thread, one set of tools
 * (src/messaging/agent.ts) — a question asked here and its answer show up
 * in the history of the next text, and vice versa.
 *
 * Session-scoped like every other /api/households route
 * (src/lib/authMiddleware.ts). `userId` in the body attributes whatever
 * the turn writes to a household member, the same way the transactions
 * route takes `createdByUserId` — an inbound text gets that from the
 * verified phone number it arrived on.
 */
chatRoute.get("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const messages = await listRecentConversation(c.env.DB, householdId, { limit: 50 });
  return c.json({
    messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, channel: m.channel, createdAt: m.created_at })),
  });
});

chatRoute.post("/", async (c) => {
  const householdId = requireParam(c, "householdId");
  const body = await c.req.json<{ message?: string; userId?: string }>();
  const message = body.message?.trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  if (!c.env.ANTHROPIC_API_KEY) return c.json({ error: "ANTHROPIC_API_KEY is not configured" }, 503);

  const { reply, mutations } = await runAgentTurn(c.env, {
    householdId,
    userId: body.userId ?? null,
    channel: "dashboard",
    text: message,
  });
  return c.json({ reply, changed: mutations.length > 0 });
});
