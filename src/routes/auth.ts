import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../types";
import { createLoginCode, consumeLoginCode } from "../db/loginCodes";
import { findUserByVerifiedPhone, getUser } from "../db/users";
import { createSession, deleteSessionByToken, getSessionByToken, sessionCookieOptions, SESSION_COOKIE } from "../lib/session";
import { getSendblueConfig } from "../lib/secrets";
import { sendMessage } from "../sendblue/client";

const PHONE_PATTERN = /^\+\d{8,15}$/;

export const authRoute = new Hono<{ Bindings: Env }>();

function setSessionCookie(c: Context<{ Bindings: Env }>, token: string) {
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(c.env));
}

// Login is the phone-verification identity anchor (src/db/users.ts's
// findUserByVerifiedPhone — already the sole trust anchor for inbound
// Sendblue replies) with a one-time code standing in for "receive a text
// from this number." Always returns {ok:true} whether or not the phone
// matches anyone, so this endpoint can't be used to enumerate which
// numbers are registered.
authRoute.post("/request-code", async (c) => {
  const body = await c.req.json<{ phoneE164?: string }>();
  if (!body.phoneE164 || !PHONE_PATTERN.test(body.phoneE164)) {
    return c.json({ error: "phoneE164 must be E.164, e.g. +13035551234" }, 400);
  }

  const user = await findUserByVerifiedPhone(c.env.DB, body.phoneE164);
  if (user) {
    const code = await createLoginCode(c.env.DB, body.phoneE164);
    await sendMessage(getSendblueConfig(c.env), {
      to: body.phoneE164,
      content: `Your Home Base login code is ${code}. It expires in 10 minutes.`,
    });
  }

  return c.json({ ok: true });
});

authRoute.post("/verify-code", async (c) => {
  const body = await c.req.json<{ phoneE164?: string; code?: string }>();
  if (!body.phoneE164 || !PHONE_PATTERN.test(body.phoneE164) || !body.code) {
    return c.json({ error: "phoneE164 and code are required" }, 400);
  }

  const result = await consumeLoginCode(c.env.DB, body.phoneE164, body.code);
  if (result !== "ok") return c.json({ error: "That code is invalid or has expired." }, 400);

  // Re-resolve rather than trusting a value carried from request-code —
  // the code alone proves the text arrived, not which household to log
  // into; this is the one lookup allowed to answer that.
  const user = await findUserByVerifiedPhone(c.env.DB, body.phoneE164);
  if (!user) return c.json({ error: "That code is invalid or has expired." }, 400);

  const { token } = await createSession(c.env.DB, { householdId: user.household_id, userId: user.id });
  setSessionCookie(c, token);
  return c.json({ householdId: user.household_id, userId: user.id, userName: user.name });
});

authRoute.get("/session", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "not logged in" }, 401);

  const session = await getSessionByToken(c.env.DB, token);
  if (!session) return c.json({ error: "not logged in" }, 401);

  const user = await getUser(c.env.DB, session.household_id, session.user_id);
  return c.json({ householdId: session.household_id, userId: session.user_id, userName: user.name });
});

authRoute.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await deleteSessionByToken(c.env.DB, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
