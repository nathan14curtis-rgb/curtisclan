import { newId } from "../lib/id";
import { sha256Hex } from "../lib/hash";
import { timingSafeEqual } from "../lib/timingSafeEqual";
import { nowIso } from "./client";

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export type ConsumeLoginCodeResult = "ok" | "invalid" | "expired" | "too_many_attempts";

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String((bytes[0] as number) % 1_000_000).padStart(6, "0");
}

function hashCode(phoneE164: string, code: string): Promise<string> {
  // Salted with the phone number so the same 6-digit code for two
  // different phones never hashes the same.
  return sha256Hex(`${phoneE164}:${code}`);
}

/** Sends a fresh 6-digit code by text (PLAN.md §10 reuses the phone as the
 * login credential). Any prior unconsumed code for this phone is
 * invalidated first — only the most recent code sent is ever valid. */
export async function createLoginCode(db: D1Database, phoneE164: string): Promise<string> {
  await db.prepare(`DELETE FROM login_code WHERE phone_e164 = ? AND consumed_at IS NULL`).bind(phoneE164).run();

  const code = generateCode();
  const codeHash = await hashCode(phoneE164, code);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

  await db
    .prepare(`INSERT INTO login_code (id, phone_e164, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`)
    .bind(newId("otp"), phoneE164, codeHash, expiresAt, now)
    .run();

  return code;
}

/** Validates a submitted code against the most recent unconsumed code for
 * this phone. A code can only ever resolve "ok" once (consumed_at is set
 * immediately) and locks out after MAX_ATTEMPTS wrong guesses — even a
 * correct guess after that point is rejected, so a code can't be brute
 * forced by retrying past the cap. */
export async function consumeLoginCode(db: D1Database, phoneE164: string, code: string): Promise<ConsumeLoginCodeResult> {
  const row = await db
    .prepare(`SELECT * FROM login_code WHERE phone_e164 = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .bind(phoneE164)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: string }>();
  if (!row) return "invalid";
  if (row.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
  if (row.expires_at <= nowIso()) return "expired";

  const candidateHash = await hashCode(phoneE164, code);
  if (!timingSafeEqual(candidateHash, row.code_hash)) {
    await db.prepare(`UPDATE login_code SET attempts = attempts + 1 WHERE id = ?`).bind(row.id).run();
    return "invalid";
  }

  await db.prepare(`UPDATE login_code SET consumed_at = ? WHERE id = ?`).bind(nowIso(), row.id).run();
  return "ok";
}
