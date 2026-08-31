import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createHousehold } from "../src/db/households";
import { createUser, verifyUserPhone } from "../src/db/users";

const db = env.DB;
const BASE = "http://curtisclan.test";

beforeEach(() => {
  Object.assign(env, {
    SENDBLUE_API_KEY_ID: "test-key-id",
    SENDBLUE_API_SECRET_KEY: "test-secret",
    SENDBLUE_FROM_NUMBER: "+15555550100",
  });
});

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
  return await worker.fetch(new Request(`${BASE}${path}`, init), env);
}

// Only ever one Set-Cookie header per response in this app (the session
// cookie), so a single-header read is fine — no need for the newer
// multi-header Headers.getSetCookie() API.
function extractSessionCookie(response: Response): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const match = raw.match(/^cc_session=([^;]+)/);
  if (!match) throw new Error(`no cc_session cookie in response: ${JSON.stringify(raw)}`);
  return `cc_session=${match[1]}`;
}

function mockSendblue() {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ message_handle: "h1", status: "QUEUED", error_code: null, from_number: "+15555550100" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function seedVerifiedHousehold() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const user = await createUser(db, household.id, { name: "Nathan" });
  await verifyUserPhone(db, household.id, user.id, "+13035551234");
  return { household, user };
}

function codeFromSendblueCall(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/send-message"));
  const body = JSON.parse((call![1] as RequestInit).body as string);
  const match = (body.content as string).match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit code found in sendblue content: ${body.content}`);
  return match[1]!;
}

describe("POST /api/auth/request-code", () => {
  it("always returns {ok:true}, whether or not the phone matches anyone", async () => {
    await seedVerifiedHousehold();
    mockSendblue();

    const known = await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    const unknown = await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+19995559999" }) });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual({ ok: true });
    expect(await unknown.json()).toEqual({ ok: true });
  });

  it("only actually texts a code for a phone that resolves to a verified user", async () => {
    await seedVerifiedHousehold();
    const fetchMock = mockSendblue();

    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+19995559999" }) });
    expect(fetchMock).not.toHaveBeenCalled();

    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("400s on a malformed phone number", async () => {
    const response = await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "not-a-phone" }) });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/auth/verify-code", () => {
  it("the right code logs in and sets a session cookie scoped to the right household", async () => {
    const { household, user } = await seedVerifiedHousehold();
    const fetchMock = mockSendblue();
    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    const code = codeFromSendblueCall(fetchMock);

    const response = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ householdId: household.id, userId: user.id, userName: user.name });
    expect(() => extractSessionCookie(response)).not.toThrow();
  });

  it("a wrong code is rejected with a generic error", async () => {
    await seedVerifiedHousehold();
    mockSendblue();
    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });

    const response = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code: "000000" }) });
    expect(response.status).toBe(400);
  });

  it("400s for a phone with no outstanding code at all", async () => {
    const response = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code: "123456" }) });
    expect(response.status).toBe(400);
  });
});

describe("session-gated access", () => {
  it("GET /api/auth/session reflects logged-in state, and 401s with no cookie", async () => {
    const loggedOut = await fetchApp("/api/auth/session");
    expect(loggedOut.status).toBe(401);

    const { household, user } = await seedVerifiedHousehold();
    const fetchMock = mockSendblue();
    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    const code = codeFromSendblueCall(fetchMock);
    const verifyResponse = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code }) });
    const cookie = extractSessionCookie(verifyResponse);

    const sessionResponse = await fetchApp("/api/auth/session", { headers: { cookie } });
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ householdId: household.id, userId: user.id, userName: user.name });
  });

  it("a household-scoped route 401s with no session at all", async () => {
    const { household } = await seedVerifiedHousehold();
    const response = await fetchApp(`/api/households/${household.id}/users`);
    expect(response.status).toBe(401);
  });

  it("a session for household A cannot reach household B's data", async () => {
    const { household: householdA } = await seedVerifiedHousehold();
    const householdB = await createHousehold(db, { name: "Other Family" });
    await createUser(db, householdB.id, { name: "Someone Else" });

    const fetchMock = mockSendblue();
    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    const code = codeFromSendblueCall(fetchMock);
    const verifyResponse = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code }) });
    const cookieForA = extractSessionCookie(verifyResponse);

    const ownHousehold = await fetchApp(`/api/households/${householdA.id}/users`, { headers: { cookie: cookieForA } });
    expect(ownHousehold.status).toBe(200);

    const otherHousehold = await fetchApp(`/api/households/${householdB.id}/users`, { headers: { cookie: cookieForA } });
    expect(otherHousehold.status).toBe(401);
  });

  it("logout invalidates the session immediately", async () => {
    await seedVerifiedHousehold();
    const fetchMock = mockSendblue();
    await fetchApp("/api/auth/request-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234" }) });
    const code = codeFromSendblueCall(fetchMock);
    const verifyResponse = await fetchApp("/api/auth/verify-code", { method: "POST", body: JSON.stringify({ phoneE164: "+13035551234", code }) });
    const cookie = extractSessionCookie(verifyResponse);

    expect((await fetchApp("/api/auth/session", { headers: { cookie } })).status).toBe(200);
    await fetchApp("/api/auth/logout", { method: "POST", headers: { cookie } });
    expect((await fetchApp("/api/auth/session", { headers: { cookie } })).status).toBe(401);
  });
});

describe("POST /api/households", () => {
  it("creating a household issues a working session for the creator in the same response", async () => {
    const response = await fetchApp("/api/households", {
      method: "POST",
      body: JSON.stringify({ name: "New Family", creatorName: "Alex" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json<{ household: { id: string }; userId: string }>();
    const cookie = extractSessionCookie(response);

    const sessionResponse = await fetchApp("/api/auth/session", { headers: { cookie } });
    expect(sessionResponse.status).toBe(200);
    expect(await sessionResponse.json()).toEqual({ householdId: body.household.id, userId: body.userId, userName: "Alex" });

    const scopedResponse = await fetchApp(`/api/households/${body.household.id}/users`, { headers: { cookie } });
    expect(scopedResponse.status).toBe(200);
  });

  it("400s without a creatorName", async () => {
    const response = await fetchApp("/api/households", { method: "POST", body: JSON.stringify({ name: "New Family" }) });
    expect(response.status).toBe(400);
  });
});
