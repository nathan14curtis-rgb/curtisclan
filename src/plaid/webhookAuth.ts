import { PlaidConfig, webhookVerificationKeyGet } from "./client";
import type { PlaidJwk } from "./types";
import { cacheWebhookKey, getCachedWebhookKey } from "../db/webhookKeyCache";

/**
 * Verifies a Plaid webhook's `Plaid-Verification` JWT (PLAN.md §4.1, §10:
 * "this is real work, not a header comparison. Don't skip it and don't
 * 'add it later' — an unverified webhook endpoint lets anyone inject
 * transactions into your ledger."). Steps per Plaid's documented scheme:
 *
 * 1. Decode the JWT header (unverified) — reject anything but ES256.
 * 2. Fetch (or use a cached) JWK for the header's `kid` from
 *    /webhook_verification_key/get; reject an expired key.
 * 3. Verify the ES256 signature over header.payload with that JWK.
 * 4. Reject a stale `iat` (replay window).
 * 5. Recompute SHA-256 of the *raw* request body and compare against the
 *    signed `request_body_sha256` claim — proves the body wasn't swapped
 *    after signing.
 */

const MAX_IAT_AGE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {}

interface JwtHeader {
  alg: string;
  kid: string;
}

interface JwtPayload {
  iat: number;
  request_body_sha256: string;
}

export async function verifyPlaidWebhook(
  db: D1Database,
  plaidConfig: PlaidConfig,
  verificationHeader: string | null,
  rawBody: string,
): Promise<void> {
  if (!verificationHeader) throw new WebhookVerificationError("missing Plaid-Verification header");

  const parts = verificationHeader.split(".");
  if (parts.length !== 3) throw new WebhookVerificationError("malformed JWT");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlDecodeToString(headerB64)) as JwtHeader;
  if (header.alg !== "ES256") throw new WebhookVerificationError(`unexpected alg: ${header.alg}`);
  if (!header.kid) throw new WebhookVerificationError("missing kid in JWT header");

  const jwk = await getVerificationKey(db, plaidConfig, header.kid);

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecodeToBytes(signatureB64);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, signature, signingInput);
  if (!valid) throw new WebhookVerificationError("signature verification failed");

  const payload = JSON.parse(base64UrlDecodeToString(payloadB64)) as JwtPayload;

  const ageSeconds = Date.now() / 1000 - payload.iat;
  if (ageSeconds > MAX_IAT_AGE_SECONDS || ageSeconds < -MAX_IAT_AGE_SECONDS) {
    throw new WebhookVerificationError(`webhook too old or clock-skewed (iat age ${Math.round(ageSeconds)}s)`);
  }

  const actualBodyHash = await sha256Hex(rawBody);
  if (actualBodyHash !== payload.request_body_sha256) {
    throw new WebhookVerificationError("request_body_sha256 mismatch — body was altered after signing");
  }
}

async function getVerificationKey(db: D1Database, plaidConfig: PlaidConfig, keyId: string): Promise<PlaidJwk> {
  const cached = await getCachedWebhookKey(db, keyId);
  if (cached) {
    if (cached.expired_at) throw new WebhookVerificationError(`verification key ${keyId} has expired`);
    return JSON.parse(cached.jwk) as PlaidJwk;
  }

  const { key } = await webhookVerificationKeyGet(plaidConfig, keyId);
  await cacheWebhookKey(db, keyId, key, key.expired_at);
  if (key.expired_at) throw new WebhookVerificationError(`verification key ${keyId} has expired`);
  return key;
}

function base64UrlDecodeToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeToString(input: string): string {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
