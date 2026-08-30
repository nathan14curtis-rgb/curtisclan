import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cacheWebhookKey } from "../src/db/webhookKeyCache";
import { verifyPlaidWebhook, WebhookVerificationError } from "../src/plaid/webhookAuth";
import type { PlaidConfig } from "../src/plaid/client";

const db = env.DB;
const dummyPlaidConfig: PlaidConfig = { clientId: "unused", secret: "unused", env: "sandbox" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds a real ES256-signed Plaid-style webhook JWT against a freshly
 * generated keypair, and caches the matching public JWK so
 * verifyPlaidWebhook never needs a network call (PLAN.md §4.1's "real
 * work, not a header comparison" — this exercises the actual crypto, not
 * a mock of it). */
async function makeSignedWebhook(
  db: D1Database,
  rawBody: string,
  opts: { kid?: string; alg?: string; iatOffsetSeconds?: number; expiredKey?: boolean; bodyForHash?: string } = {},
): Promise<string> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const kid = opts.kid ?? "test-key-1";

  await cacheWebhookKey(
    db,
    kid,
    { alg: "ES256", crv: "P-256", kid, kty: "EC", use: "sig", x: publicJwk.x, y: publicJwk.y },
    opts.expiredKey ? "2020-01-01T00:00:00Z" : null,
  );

  const header = { alg: opts.alg ?? "ES256", typ: "JWT", kid };
  const iat = Math.floor(Date.now() / 1000) + (opts.iatOffsetSeconds ?? 0);
  const payload = { iat, request_body_sha256: await sha256Hex(opts.bodyForHash ?? rawBody) };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  return `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

describe("verifyPlaidWebhook", () => {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1" });

  it("accepts a validly signed, fresh webhook", async () => {
    const jwt = await makeSignedWebhook(db, body);
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body)).resolves.toBeUndefined();
  });

  it("rejects a missing header", async () => {
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, null, body)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects a non-ES256 alg", async () => {
    const jwt = await makeSignedWebhook(db, body, { alg: "HS256" });
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body)).rejects.toThrow(/unexpected alg/);
  });

  it("rejects a body that doesn't match the signed request_body_sha256 (tampering)", async () => {
    const jwt = await makeSignedWebhook(db, body);
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body + "tampered")).rejects.toThrow(/request_body_sha256/);
  });

  it("rejects a stale iat (replay window)", async () => {
    const jwt = await makeSignedWebhook(db, body, { iatOffsetSeconds: -60 * 60 });
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body)).rejects.toThrow(/too old/);
  });

  it("rejects an expired verification key", async () => {
    const jwt = await makeSignedWebhook(db, body, { expiredKey: true });
    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body)).rejects.toThrow(/expired/);
  });

  it("rejects a signature from the wrong key", async () => {
    // Sign with one keypair, but cache a *different* key under the same kid
    // (simulating a forged token that guesses at a valid kid).
    const wrongKeyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const wrongJwk = (await crypto.subtle.exportKey("jwk", wrongKeyPair.publicKey)) as JsonWebKey;
    const kid = "shared-kid";

    const header = { alg: "ES256", typ: "JWT", kid };
    const iat = Math.floor(Date.now() / 1000);
    const payload = { iat, request_body_sha256: await sha256Hex(body) };
    const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const forgedSigningKey = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      forgedSigningKey.privateKey,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    const jwt = `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;

    // Cache the *real* (wrong-for-this-token) public key under that kid.
    await cacheWebhookKey(db, kid, { alg: "ES256", crv: "P-256", kid, kty: "EC", use: "sig", x: wrongJwk.x, y: wrongJwk.y }, null);

    await expect(verifyPlaidWebhook(db, dummyPlaidConfig, jwt, body)).rejects.toThrow(/signature verification failed/);
  });
});
