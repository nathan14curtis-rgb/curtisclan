import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { applyCategorization, createTransaction } from "../src/db/transactions";
import { listCategories } from "../src/db/categories";
import { sendDailyDigest } from "../src/messaging/dailyDigest";

const db = env.DB;

beforeEach(() => {
  Object.assign(env, {
    SENDBLUE_API_KEY_ID: "test-key-id",
    SENDBLUE_API_SECRET_KEY: "test-secret-key",
    SENDBLUE_FROM_NUMBER: "+15555550100",
    SENDBLUE_API_BASE_URL: "https://fake.sendblue.test/api",
  });
});

function mockFetchOnce(responseBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, nathan.id, "+13035551111");
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  return { household, checking };
}

describe("sendDailyDigest", () => {
  it("lists recently categorized transactions and invites a plain-English correction", async () => {
    const { household, checking } = await seedHousehold();
    const categories = await listCategories(db, household.id);
    const groceries = categories.find((c) => c.name === "Groceries")!;
    const dining = categories.find((c) => c.name === "Dining Out")!;

    const walmart = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4523, rawDescription: "WALMART", normalizedMerchant: "WALMART",
    });
    await applyCategorization(db, household.id, walmart.id, { categoryId: groceries.id, method: "rule" });

    const chipotle = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "CHIPOTLE", normalizedMerchant: "CHIPOTLE",
    });
    await applyCategorization(db, household.id, chipotle.id, { categoryId: dining.id, method: "llm", confidence: 0.95 });

    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });
    await sendDailyDigest(env, household.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("$45.23 WALMART → Groceries");
    expect(body.content).toContain("$12.00 CHIPOTLE → Dining Out");
    expect(body.content).toContain("Tell me if I got any of them wrong");
  });

  it("leaves out a charge a human already categorized — the digest reports what the app decided, not what someone told it", async () => {
    const { household, checking } = await seedHousehold();
    const categories = await listCategories(db, household.id);
    const groceries = categories.find((c) => c.name === "Groceries")!;
    const dining = categories.find((c) => c.name === "Dining Out")!;

    const auto = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4523, rawDescription: "WALMART", normalizedMerchant: "WALMART",
    });
    await applyCategorization(db, household.id, auto.id, { categoryId: groceries.id, method: "rule" });

    const answeredByText = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -1200, rawDescription: "CHIPOTLE", normalizedMerchant: "CHIPOTLE",
    });
    await applyCategorization(db, household.id, answeredByText.id, { categoryId: dining.id, method: "llm", confidence: 0.4 });
    // ...then corrected by a text an hour later. Reporting it back in the
    // morning digest tells the person what they themselves just said.
    await applyCategorization(db, household.id, answeredByText.id, { categoryId: groceries.id, method: "human" });

    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });
    await sendDailyDigest(env, household.id);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("WALMART");
    expect(body.content).not.toContain("CHIPOTLE");
  });

  it("sends nothing when nothing was categorized recently", async () => {
    const { household } = await seedHousehold();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await sendDailyDigest(env, household.id);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
