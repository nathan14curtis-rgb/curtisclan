import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createSession, deleteSessionByToken, getSessionByToken } from "../src/lib/session";

const db = env.DB;

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const user = await createUser(db, household.id, { name: "Nathan" });
  return { household, user };
}

describe("createSession / getSessionByToken", () => {
  it("round-trips: the plaintext token resolves back to the session that minted it", async () => {
    const { household, user } = await seed();
    const { token, session } = await createSession(db, { householdId: household.id, userId: user.id });

    const resolved = await getSessionByToken(db, token);
    expect(resolved?.id).toBe(session.id);
    expect(resolved?.household_id).toBe(household.id);
    expect(resolved?.user_id).toBe(user.id);
  });

  it("never stores the plaintext token — only its hash is in the row", async () => {
    const { household, user } = await seed();
    const { token, session } = await createSession(db, { householdId: household.id, userId: user.id });
    expect(session.token_hash).not.toBe(token);
    expect(session.token_hash).toHaveLength(64); // full sha256 hex
  });

  it("returns null for a token that was never issued", async () => {
    expect(await getSessionByToken(db, "not-a-real-token")).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const { household, user } = await seed();
    const { token, session } = await createSession(db, { householdId: household.id, userId: user.id });
    // Backdate it past expiry directly — createSession always mints a
    // 30-day-out expiry, so this is the only way to exercise the check.
    await db.prepare(`UPDATE session SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`).bind(session.id).run();

    expect(await getSessionByToken(db, token)).toBeNull();
  });

  it("touches last_seen_at on each successful lookup", async () => {
    const { household, user } = await seed();
    const { token, session } = await createSession(db, { householdId: household.id, userId: user.id });
    await db.prepare(`UPDATE session SET last_seen_at = '2000-01-01 00:00:00' WHERE id = ?`).bind(session.id).run();

    const resolved = await getSessionByToken(db, token);
    expect(resolved?.last_seen_at).not.toBe("2000-01-01 00:00:00");
  });
});

describe("deleteSessionByToken", () => {
  it("invalidates the session immediately — logout can't be replayed", async () => {
    const { household, user } = await seed();
    const { token } = await createSession(db, { householdId: household.id, userId: user.id });
    expect(await getSessionByToken(db, token)).not.toBeNull();

    await deleteSessionByToken(db, token);
    expect(await getSessionByToken(db, token)).toBeNull();
  });

  it("is a no-op for a token that doesn't exist", async () => {
    await expect(deleteSessionByToken(db, "never-issued")).resolves.toBeUndefined();
  });
});
