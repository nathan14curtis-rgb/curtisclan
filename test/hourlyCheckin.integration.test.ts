import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { createTransaction } from "../src/db/transactions";
import { createClarification, getClarification } from "../src/db/clarifications";
import { listRecentConversation } from "../src/db/conversations";
import { sendHourlyCheckin } from "../src/messaging/hourlyCheckin";

const db = env.DB;

beforeEach(() => {
  Object.assign(env, {
    SENDBLUE_API_KEY_ID: "test-key-id",
    SENDBLUE_API_SECRET_KEY: "test-secret-key",
    SENDBLUE_FROM_NUMBER: "+15555550100",
    SENDBLUE_API_BASE_URL: "https://fake.sendblue.test/api",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, nathan.id, `+1303555${Math.floor(1000 + Math.random() * 8999)}`);
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  return { household, nathan, checking };
}

async function queueAsk(householdId: string, userId: string, accountId: string, merchant: string, amountCents: number) {
  const txn = await createTransaction(db, householdId, {
    accountId, postedAt: "2026-09-04", amountCents, rawDescription: merchant, normalizedMerchant: merchant,
  });
  return createClarification(db, householdId, { transactionId: txn.id, userId, questionText: `${merchant}. What was this?` });
}

const noRequeue = async () => {
  throw new Error("should not requeue");
};

describe("sendHourlyCheckin", () => {
  it("asks about the hour's unplaceable charges in one message, not one text each", async () => {
    const { household, nathan, checking } = await seed();
    const first = await queueAsk(household.id, nathan.id, checking.id, "THE HIVE MERCANTILE", -4783);
    const second = await queueAsk(household.id, nathan.id, checking.id, "SQ *UNKNOWN", -1200);
    const fetchMock = mockFetchOnce();

    await sendHourlyCheckin(env, household.id, noRequeue);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("2 new charges I couldn't place:");
    expect(body.content).toContain("- $47.83 at THE HIVE MERCANTILE (Chase Checking)");
    expect(body.content).toContain("- $12.00 at SQ *UNKNOWN (Chase Checking)");

    expect((await getClarification(db, household.id, first.id)).status).toBe("sent");
    expect((await getClarification(db, household.id, second.id)).status).toBe("sent");

    // Recorded as a turn, so a reply of "both were groceries" has
    // something to resolve against.
    const thread = await listRecentConversation(db, household.id);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.content).toBe(body.content);
  });

  it("sends nothing at all when the hour brought in nothing to ask about", async () => {
    const { household } = await seed();
    const fetchMock = mockFetchOnce();

    await sendHourlyCheckin(env, household.id, noRequeue);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never asks twice about the same charge", async () => {
    const { household, nathan, checking } = await seed();
    await queueAsk(household.id, nathan.id, checking.id, "THE HIVE MERCANTILE", -4783);
    const fetchMock = mockFetchOnce();

    await sendHourlyCheckin(env, household.id, noRequeue);
    await sendHourlyCheckin(env, household.id, noRequeue);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("times out an ask that sat unsent for more than a day rather than raising it late", async () => {
    const { household, nathan, checking } = await seed();
    const stale = await queueAsk(household.id, nathan.id, checking.id, "LAST WEEK'S MYSTERY", -3300);
    await db
      .prepare(`UPDATE clarification SET created_at = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, ""), stale.id)
      .run();
    const fetchMock = mockFetchOnce();

    await sendHourlyCheckin(env, household.id, noRequeue);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getClarification(db, household.id, stale.id)).status).toBe("timed_out");
  });

  it("defers the whole batch into the morning during quiet hours instead of sending at 2am", async () => {
    const { household, nathan, checking } = await seed();
    // Quiet hours have no updater in src/db/users.ts (they're seeded, not
    // edited), so set the window directly — everything but the current
    // minute, so this test never depends on when it runs.
    await db
      .prepare(`UPDATE user SET timezone = 'UTC', quiet_hours_start = '00:00', quiet_hours_end = '23:59' WHERE id = ?`)
      .bind(nathan.id)
      .run();
    const ask = await queueAsk(household.id, nathan.id, checking.id, "MIDNIGHT SNACK", -800);
    const fetchMock = mockFetchOnce();
    const requeued: number[] = [];

    await sendHourlyCheckin(env, household.id, async (delaySeconds) => {
      requeued.push(delaySeconds);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toBeGreaterThan(0);
    // Still queued — nothing is dropped, it just waits for the requeued job.
    expect((await getClarification(db, household.id, ask.id)).status).toBe("queued");
  });
});
