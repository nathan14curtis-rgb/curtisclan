import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold, getHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { applyCategorization, createTransaction, findRecentTransactionByMerchantSubstring } from "../src/db/transactions";
import { listCategories } from "../src/db/categories";
import { getLatestClarificationForTransaction } from "../src/db/clarifications";
import { sendToHouseholdGroup } from "../src/messaging/groupChat";
import { processInboundReply } from "../src/messaging/inboundProcessing";

const db = env.DB;

beforeEach(() => {
  // getSendblueConfig() reads these via requireSecret — this test
  // environment has no real Sendblue account, so stub in fake-but-present
  // values and intercept the actual HTTP call instead.
  Object.assign(env, {
    SENDBLUE_API_KEY_ID: "test-key-id",
    SENDBLUE_API_SECRET_KEY: "test-secret-key",
    SENDBLUE_API_BASE_URL: "https://fake.sendblue.test/api",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchOnce(responseBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(responseBody), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const wife = await createUser(db, household.id, { name: "Wife" });
  await verifyUserPhone(db, household.id, nathan.id, "+13035551111");
  await verifyUserPhone(db, household.id, wife.id, "+13035552222");
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking", ownerUserId: nathan.id });
  return { household, nathan, wife, checking };
}

describe("sendToHouseholdGroup", () => {
  it("creates the group on first send with every verified number, and persists the group_id", async () => {
    const { household } = await seedHousehold();
    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    const result = await sendToHouseholdGroup(env, household.id, "hello household");

    expect(result.messageHandle).toBe("mh_1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://fake.sendblue.test/api/send-group-message");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.numbers.sort()).toEqual(["+13035551111", "+13035552222"]);
    expect(body.content).toBe("hello household");

    const updated = await getHousehold(db, household.id);
    expect(updated.group_chat_id).toBe("grp_abc");
  });

  it("reuses the stored group_id on a later send instead of recreating the group", async () => {
    const { household } = await seedHousehold();
    mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });
    await sendToHouseholdGroup(env, household.id, "first message");

    const fetchMock = mockFetchOnce({ message_handle: "mh_2", group_id: "grp_abc", status: "QUEUED", error_code: null });
    await sendToHouseholdGroup(env, household.id, "second message");

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ group_id: "grp_abc", content: "second message" });
  });

  it("does nothing when nobody in the household has a verified phone", async () => {
    const household = await createHousehold(db, { name: "No Phones Yet" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendToHouseholdGroup(env, household.id, "hello?");
    expect(result.messageHandle).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("processInboundReply — 'fix' command is household-scoped", () => {
  it("lets anyone in the household — not just the account owner — trigger a correction", async () => {
    const { household, wife, checking } = await seedHousehold();
    const created = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -4500, rawDescription: "WALMART", normalizedMerchant: "WALMART",
    });
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    await applyCategorization(db, household.id, created.id, { categoryId: groceries.id, method: "human" });
    const txn = await findRecentTransactionByMerchantSubstring(db, household.id, "walmart");

    // The wife sends "fix walmart" — she's not the account owner (Nathan
    // is), but the household group model means anyone can request a
    // correction on anything, not just their own card's charges.
    await processInboundReply(env, household.id, wife.id, "fix walmart");

    const clarification = await getLatestClarificationForTransaction(db, household.id, txn!.id);
    expect(clarification?.status).toBe("queued");
    expect(clarification?.question_text).toContain("WALMART");
    expect(clarification?.user_id).toBe(wife.id);
  });

  it("tells the household group when nothing matches, instead of failing silently", async () => {
    const { household, nathan } = await seedHousehold();
    const fetchMock = mockFetchOnce({ message_handle: "mh_none", group_id: "grp_new", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "fix some place that never happened");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("some place that never happened");
  });
});
