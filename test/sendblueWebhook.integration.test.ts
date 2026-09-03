import { env } from "cloudflare:test";
import worker from "../src/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";
import { findInboundMessageByHandle, listInboundMessagesForDiagnostics } from "../src/db/inboundMessages";

const db = env.DB;
const SIGNING_SECRET = "test-signing-secret";

beforeEach(() => {
  Object.assign(env, { SENDBLUE_SIGNING_SECRET: SIGNING_SECRET });
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore the secret for whatever runs next — the 503 case below clears
  // it, and every test file in this project shares one `env` object.
  Object.assign(env, { SENDBLUE_SIGNING_SECRET: SIGNING_SECRET });
});

/** Capture what this route hands to TRANSACTION_QUEUE — that handoff is the
 * whole point of the route — without forwarding to the real queue. A real
 * send would run the consumer asynchronously, and its DB work lands after
 * the test's isolated-storage frame has already been popped. */
function captureQueue() {
  const sent: unknown[] = [];
  vi.spyOn(env.TRANSACTION_QUEUE, "send").mockImplementation(async (body: unknown) => {
    sent.push(body);
    return { outcome: "ok" } as unknown as QueueSendResponse;
  });
  return sent;
}

function inboundPayload(overrides: Record<string, unknown> = {}) {
  return {
    message_handle: `mh_${Math.random().toString(36).slice(2)}`,
    from_number: "+13035551111",
    content: "starbucks was coffee",
    is_outbound: false,
    date_sent: new Date().toISOString(),
    ...overrides,
  };
}

/** Calls the Worker's own fetch handler rather than SELF: these tests
 * drive secret-misconfiguration cases by mutating `env`, and SELF resolves
 * its bindings from the wrangler config instead of the mutated object.
 * The response body is drained before returning so nothing is left
 * undisposed when the isolated-storage frame pops between tests. */
async function postWebhook(
  body: unknown,
  headers: Record<string, string> = { "sb-signing-secret": SIGNING_SECRET },
  path = "/webhooks/sendblue",
) {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  await res.text();
  return res;
}

async function seedVerifiedUser(phone: string) {
  const household = await createHousehold(db, { name: `H ${Math.random()}` });
  const user = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, user.id, phone);
  return { household, user };
}

describe("POST /webhooks/sendblue", () => {
  it("records the text and queues it for resolution when the number is verified", async () => {
    const { household, user } = await seedVerifiedUser("+13035551111");
    const sent = captureQueue();
    const payload = inboundPayload({ from_number: "+13035551111" });

    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    const stored = await findInboundMessageByHandle(db, payload.message_handle);
    expect(stored?.household_id).toBe(household.id);
    expect(stored?.content).toBe("starbucks was coffee");
    expect(sent).toContainEqual({
      type: "resolve_reply",
      householdId: household.id,
      userId: user.id,
      inboundMessageId: stored!.id,
    });
  });

  it("rejects a request whose signing secret does not match, without recording anything", async () => {
    captureQueue();
    await seedVerifiedUser("+13035552222");
    const payload = inboundPayload({ from_number: "+13035552222" });

    const res = await postWebhook(payload, { "sb-signing-secret": "wrong" });

    expect(res.status).toBe(401);
    expect(await findInboundMessageByHandle(db, payload.message_handle)).toBeNull();
  });

  it("reports 503, not a generic 500, when SENDBLUE_SIGNING_SECRET was never set", async () => {
    captureQueue();
    Object.assign(env, { SENDBLUE_SIGNING_SECRET: undefined });
    const res = await postWebhook(inboundPayload());
    expect(res.status).toBe(503);
  });

  it("still resolves the household when Sendblue sends a bare 10-digit from_number", async () => {
    captureQueue();
    const { household } = await seedVerifiedUser("+13035553333");
    const payload = inboundPayload({ from_number: "3035553333" });

    await postWebhook(payload);

    const stored = await findInboundMessageByHandle(db, payload.message_handle);
    expect(stored?.household_id).toBe(household.id);
  });

  it("falls back to a last-10-digit match when the stored number carries a different country prefix", async () => {
    captureQueue();
    // Verified as a bare-ish E.164 that normalizePhone can't turn into the
    // inbound form — the exact match misses and the suffix match recovers it.
    const { household } = await seedVerifiedUser("+443035554444");
    const payload = inboundPayload({ from_number: "+13035554444" });

    await postWebhook(payload);

    const stored = await findInboundMessageByHandle(db, payload.message_handle);
    expect(stored?.household_id).toBe(household.id);
  });

  it("records an unmatched number instead of dropping it, and does not queue it", async () => {
    const sent = captureQueue();
    const payload = inboundPayload({ from_number: "+19995550000" });

    const res = await postWebhook(payload);

    expect(res.status).toBe(200);
    const stored = await findInboundMessageByHandle(db, payload.message_handle);
    expect(stored).not.toBeNull();
    expect(stored?.household_id).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("does not double-process a redelivered message_handle", async () => {
    await seedVerifiedUser("+13035555555");
    const sent = captureQueue();
    const payload = inboundPayload({ from_number: "+13035555555" });

    await postWebhook(payload);
    await postWebhook(payload);

    expect(sent).toHaveLength(1);
  });

  it("ignores the status callback for our own outbound sends", async () => {
    const sent = captureQueue();
    const payload = inboundPayload({ is_outbound: true });

    await postWebhook(payload);

    expect(sent).toHaveLength(0);
    expect(await findInboundMessageByHandle(db, payload.message_handle)).toBeNull();
  });


  it("accepts the webhook URL with a trailing slash", async () => {
    // A trailing slash used to fall through to Hono's default 404, which
    // logs nothing — the same observable behaviour as Sendblue never
    // calling at all, and impossible to tell apart from the outside.
    const { household } = await seedVerifiedUser("+13035557777");
    captureQueue();
    const payload = inboundPayload({ from_number: "+13035557777" });

    const res = await postWebhook(payload, { "sb-signing-secret": SIGNING_SECRET }, "/webhooks/sendblue/");

    expect(res.status).toBe(200);
    const stored = await findInboundMessageByHandle(db, payload.message_handle);
    expect(stored?.household_id).toBe(household.id);
  });

  it("404s a misdirected /webhooks/* path loudly instead of silently", async () => {
    const res = await postWebhook(inboundPayload(), { "sb-signing-secret": SIGNING_SECRET }, "/webhooks/sendblu");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 400 rather than a generic 500 on a non-JSON body", async () => {
    captureQueue();
    const res = await postWebhook("not json at all");
    expect(res.status).toBe(400);
  });
});

describe("messaging diagnostics", () => {
  it("surfaces texts from numbers that matched no verified user", async () => {
    captureQueue();
    const { household } = await seedVerifiedUser("+13035556666");
    await postWebhook(inboundPayload({ from_number: "+19995559999", content: "hello?" }));

    const rows = await listInboundMessagesForDiagnostics(db, household.id, 20);
    const unmatched = rows.filter((r) => r.household_id === null);
    expect(unmatched.some((r) => r.from_number === "+19995559999")).toBe(true);
  });
});
