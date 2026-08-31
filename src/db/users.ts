import { newId } from "../lib/id";
import type { AccessLevel, User } from "../types";
import { getScoped, listScoped, NotFoundError, nowIso } from "./client";

export async function listUsers(db: D1Database, householdId: string): Promise<User[]> {
  return listScoped<User>(db, "user", householdId, "name");
}

export async function getUser(db: D1Database, householdId: string, id: string): Promise<User> {
  return getScoped<User>(db, "user", householdId, id);
}

export async function createUser(
  db: D1Database,
  householdId: string,
  input: {
    name: string;
    timezone?: string;
    role?: string | null;
    accessLevel?: AccessLevel;
    weeklyAllowanceCents?: number | null;
    note?: string | null;
  },
): Promise<User> {
  const id = newId("usr");
  const now = nowIso();
  const timezone = input.timezone ?? "America/Denver";
  const role = input.role ?? null;
  const accessLevel = input.accessLevel ?? "full";
  const weeklyAllowanceCents = input.weeklyAllowanceCents ?? null;
  const note = input.note ?? null;
  await db
    .prepare(
      `INSERT INTO user (id, household_id, name, timezone, notification_prefs, role, access_level, weekly_allowance_cents, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, householdId, input.name, timezone, role, accessLevel, weeklyAllowanceCents, note, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    name: input.name,
    phone_e164: null,
    phone_verified_at: null,
    timezone,
    quiet_hours_start: null,
    quiet_hours_end: null,
    notification_prefs: "{}",
    role,
    access_level: accessLevel,
    weekly_allowance_cents: weeklyAllowanceCents,
    note,
    created_at: now,
    updated_at: now,
  };
}

/** Member profile fields the redesigned Members page edits — name/timezone
 * plus the new role/access_level/allowance/note fields. Same
 * omitted-vs-explicit-null convention as updateAccount/updateEnvelope. */
export async function updateUser(
  db: D1Database,
  householdId: string,
  id: string,
  input: {
    name?: string;
    timezone?: string;
    role?: string | null;
    accessLevel?: AccessLevel;
    weeklyAllowanceCents?: number | null;
    note?: string | null;
  },
): Promise<User> {
  const existing = await getUser(db, householdId, id);
  const name = input.name ?? existing.name;
  const timezone = input.timezone ?? existing.timezone;
  const role = "role" in input ? (input.role ?? null) : existing.role;
  const accessLevel = input.accessLevel ?? existing.access_level;
  const weeklyAllowanceCents = "weeklyAllowanceCents" in input ? (input.weeklyAllowanceCents ?? null) : existing.weekly_allowance_cents;
  const note = "note" in input ? (input.note ?? null) : existing.note;
  const now = nowIso();
  await db
    .prepare(
      `UPDATE user SET name = ?, timezone = ?, role = ?, access_level = ?, weekly_allowance_cents = ?, note = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`,
    )
    .bind(name, timezone, role, accessLevel, weeklyAllowanceCents, note, now, id, householdId)
    .run();
  return { ...existing, name, timezone, role, access_level: accessLevel, weekly_allowance_cents: weeklyAllowanceCents, note, updated_at: now };
}

/** Binds from_number to a verified user (PLAN §5.0, §10). Called once the
 * Sendblue verification handshake completes — never trust an unverified
 * from_number to authenticate an inbound reply. */
export async function verifyUserPhone(
  db: D1Database,
  householdId: string,
  userId: string,
  phoneE164: string,
): Promise<User> {
  const now = nowIso();
  const result = await db
    .prepare(
      `UPDATE user SET phone_e164 = ?, phone_verified_at = ?, updated_at = ?
       WHERE id = ? AND household_id = ?`,
    )
    .bind(phoneE164, now, now, userId, householdId)
    .run();
  if (result.meta.changes === 0) throw new NotFoundError("user", userId);
  return getUser(db, householdId, userId);
}

/** The only place an inbound Sendblue message is allowed to resolve to a
 * household: by an already-verified phone number. */
export async function findUserByVerifiedPhone(db: D1Database, phoneE164: string): Promise<User | null> {
  return db
    .prepare(`SELECT * FROM user WHERE phone_e164 = ? AND phone_verified_at IS NOT NULL`)
    .bind(phoneE164)
    .first<User>();
}

/** Every household member who can actually receive iMessages — the
 * recipient list for the shared group thread (src/messaging/groupChat.ts)
 * and the set whose quiet hours gate a proactive send. */
export async function listVerifiedUsersForHousehold(db: D1Database, householdId: string): Promise<User[]> {
  const { results } = await db
    .prepare(`SELECT * FROM user WHERE household_id = ? AND phone_verified_at IS NOT NULL ORDER BY created_at`)
    .bind(householdId)
    .all<User>();
  return results;
}
