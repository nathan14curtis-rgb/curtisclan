import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { createHousehold, getHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { applyCategorization, createTransaction, getTransaction } from "../src/db/transactions";
import { listCategories } from "../src/db/categories";
import { allocateToEnvelope, listEnvelopes } from "../src/db/envelopes";
import { listRecentConversation } from "../src/db/conversations";
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
    SENDBLUE_FROM_NUMBER: "+15555550100",
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
    expect(body).toEqual({ group_id: "grp_abc", content: "second message", from_number: "+15555550100" });
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

/** A stand-in for the Anthropic client that hands back one canned response
 * per call, in order — the agent loop calls messages.create once per tool
 * round, so a scripted conversation is a list of responses. */
function scriptedClient(responses: unknown[]) {
  const create = vi.fn();
  for (const response of responses) create.mockResolvedValueOnce(response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

function toolUse(name: string, input: unknown) {
  return { content: [{ type: "tool_use", id: `tu_${name}`, name, input }], stop_reason: "tool_use" };
}

function finalText(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn" };
}

describe("processInboundReply — the conversational agent", () => {
  it("acts on a plain-English correction through its tools and texts back what it did", async () => {
    const { household, nathan, checking } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: "test-anthropic-key" });

    const month = new Date().toISOString().slice(0, 7);
    const categories = await listCategories(db, household.id);
    const entertainment = categories.find((c) => c.name === "Entertainment")!;
    const misc = categories.find((c) => c.name === "Miscellaneous")!;

    const uber = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: `${month}-15`, amountCents: -1200, rawDescription: "UBER TRIP", normalizedMerchant: "UBER",
    });
    // Auto-filed by the cascade, exactly as the daily digest would have
    // reported it that morning.
    await applyCategorization(db, household.id, uber.id, { categoryId: entertainment.id, method: "llm", confidence: 0.6 });
    const miscEnvelope = (await listEnvelopes(db, household.id)).find((e) => e.category_id === misc.id)!;
    await allocateToEnvelope(db, household.id, { envelopeId: miscEnvelope.id, month, amountCents: 10000 });

    const { client, create } = scriptedClient([
      toolUse("categorize_transactions", { items: [{ transaction_id: uber.id, category: "Miscellaneous", memo: "business trip" }] }),
      finalText("Moved the $12.00 UBER to Miscellaneous — $88 left there this month."),
    ]);
    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "actually, the uber was for business", client);

    const updated = await getTransaction(db, household.id, uber.id);
    expect(updated.category_id).toBe(misc.id);
    expect(updated.memo).toBe("business trip");

    // The charge it corrected was in the situation block, so the model
    // never had to go looking for it.
    const firstCall = create.mock.calls[0]![0];
    expect(JSON.stringify(firstCall.messages)).toContain(uber.id);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toBe("Moved the $12.00 UBER to Miscellaneous — $88 left there this month.");
  });

  it("keeps both sides of the exchange, so the next text has the thread", async () => {
    const { household, nathan } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: "test-anthropic-key" });
    const { client } = scriptedClient([finalText("You've spent $312 on groceries so far this month.")]);
    mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "how much on groceries this month?", client);

    const thread = await listRecentConversation(db, household.id);
    expect(thread.map((m) => [m.role, m.content])).toEqual([
      ["user", "how much on groceries this month?"],
      ["assistant", "You've spent $312 on groceries so far this month."],
    ]);
    expect(thread[0]!.user_id).toBe(nathan.id);
  });

  it("answers a question with no charges in play at all, instead of falling back to 'nothing to match'", async () => {
    const { household, nathan } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: "test-anthropic-key" });
    const { client, create } = scriptedClient([
      toolUse("get_spending_plan", {}),
      finalText("Nothing's over yet this month — dining is the closest at $40 left."),
    ]);
    const fetchMock = mockFetchOnce({ message_handle: "mh_qa", group_id: "grp_abc", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "are we over on anything?", client);

    expect(create).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("Nothing's over yet");
  });

  it("hands a bad tool argument back to the model to retry rather than dying on it", async () => {
    const { household, nathan, checking } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: "test-anthropic-key" });
    const groceries = (await listCategories(db, household.id)).find((c) => c.name === "Groceries")!;
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id, postedAt: "2026-03-10", amountCents: -2200, rawDescription: "THE HIVE MERCANTILE", normalizedMerchant: "THE HIVE MERCANTILE",
    });

    const { client, create } = scriptedClient([
      toolUse("categorize_transactions", { items: [{ transaction_id: txn.id, category: "Craft Supplies" }] }),
      toolUse("categorize_transactions", { items: [{ transaction_id: txn.id, category: "Groceries" }] }),
      finalText("Filed the $22.00 Hive Mercantile charge under Groceries."),
    ]);
    mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "the hive one was craft supplies, or groceries I guess", client);

    // The failed first attempt came back as an is_error tool_result naming
    // the real categories — that's what makes the second attempt possible.
    // (The loop appends to one messages array, so the recorded calls all
    // point at its final state; look through the whole thing.)
    const blocks = JSON.parse(JSON.stringify(create.mock.calls.at(-1)![0].messages)).flatMap((m: { content: unknown }) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const errors = blocks.filter((b: { type: string; is_error?: boolean }) => b.type === "tool_result" && b.is_error);
    expect(errors).toHaveLength(1);
    expect(errors[0].content).toContain("No category named 'Craft Supplies'");

    expect((await getTransaction(db, household.id, txn.id)).category_id).toBe(groceries.id);
  });

  it("texts back instead of doing nothing when ANTHROPIC_API_KEY isn't configured", async () => {
    const { household, nathan } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: undefined });
    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    await processInboundReply(env, household.id, nathan.id, "that was actually for the kids");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("isn't set up");
  });

  it("texts back instead of dying silently when the model call itself throws", async () => {
    const { household, nathan } = await seedHousehold();
    Object.assign(env, { ANTHROPIC_API_KEY: "test-anthropic-key" });
    const failingClient = { messages: { create: vi.fn().mockRejectedValue(new Error("anthropic 529: overloaded")) } } as unknown as Anthropic;
    const fetchMock = mockFetchOnce({ message_handle: "mh_1", group_id: "grp_abc", status: "QUEUED", error_code: null });

    // This used to propagate to the queue consumer, which retries a few
    // times and then drops the job — nothing ever reaches the person who
    // texted in.
    await processInboundReply(env, household.id, nathan.id, "that was actually for the kids", failingClient);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toContain("hit a hiccup");
  });
});
