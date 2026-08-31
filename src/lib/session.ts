import type { CookieOptions } from "hono/utils/cookie";
import { newId } from "./id";
import { sha256Hex } from "./hash";
import type { Env, Session } from "../types";
import { nowIso } from "../db/client";

/** Real login (PLAN.md §10: household data is "the highest-consequence
 * data you'll ever own"), replacing the old localStorage-only household
 * id. A session token is a random bearer value — the cookie is the only
 * place it exists in plaintext; the DB stores only its hash, same
 * reasoning as encrypting Plaid access tokens at rest. */

export const SESSION_COOKIE = "cc_session";
export const SESSION_TTL_DAYS = 30;

/** `Secure` requires HTTPS — real deploys are always HTTPS (Cloudflare
 * terminates TLS), but `wrangler dev`/local testing serves plain HTTP on
 * localhost, where a Secure cookie would silently never be stored. Same
 * ENVIRONMENT var wrangler.jsonc's "vars" already sets for exactly this
 * kind of dev-vs-real distinction (see src/index.ts's /health handler). */
export function sessionCookieOptions(env: Env): CookieOptions {
  return {
    httpOnly: true,
    secure: env.ENVIRONMENT !== "development",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function expiryFromNow(): string {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

export async function createSession(
  db: D1Database,
  input: { householdId: string; userId: string },
): Promise<{ token: string; session: Session }> {
  const token = generateToken();
  const tokenHash = await sha256Hex(token);
  const id = newId("ses");
  const now = nowIso();
  const expiresAt = expiryFromNow();
  await db
    .prepare(
      `INSERT INTO session (id, token_hash, household_id, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tokenHash, input.householdId, input.userId, now, expiresAt, now)
    .run();
  return {
    token,
    session: { id, token_hash: tokenHash, household_id: input.householdId, user_id: input.userId, created_at: now, expires_at: expiresAt, last_seen_at: now },
  };
}

/** Resolves a bearer token to its session, or null if it doesn't exist or
 * has expired. Expired sessions are left in place (not deleted here) —
 * cleanup is not this call's job, just correctness of the check. */
export async function getSessionByToken(db: D1Database, token: string): Promise<Session | null> {
  const tokenHash = await sha256Hex(token);
  const session = await db.prepare(`SELECT * FROM session WHERE token_hash = ?`).bind(tokenHash).first<Session>();
  if (!session) return null;
  if (session.expires_at <= nowIso()) return null;

  const now = nowIso();
  await db.prepare(`UPDATE session SET last_seen_at = ? WHERE id = ?`).bind(now, session.id).run();
  return { ...session, last_seen_at: now };
}

export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.prepare(`DELETE FROM session WHERE token_hash = ?`).bind(tokenHash).run();
}
