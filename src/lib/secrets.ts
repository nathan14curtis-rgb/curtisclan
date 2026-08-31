import { importEncryptionKey } from "./crypto";
import type { PlaidConfig } from "../plaid/client";
import type { SendblueConfig } from "../sendblue/client";
import type { Env } from "../types";

export function requireSecret(env: Env, name: keyof Env): string {
  const value = env[name];
  if (!value || typeof value !== "string") {
    throw new Error(`missing required secret: ${name} (wrangler secret put ${name})`);
  }
  return value;
}

export function getPlaidConfig(env: Env): PlaidConfig {
  return {
    clientId: requireSecret(env, "PLAID_CLIENT_ID"),
    secret: requireSecret(env, "PLAID_SECRET"),
    env: (env.PLAID_ENV ?? "sandbox") as PlaidConfig["env"],
  };
}

export async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  return importEncryptionKey(requireSecret(env, "TOKEN_ENCRYPTION_KEY"));
}

export function getSendblueConfig(env: Env): SendblueConfig {
  return {
    apiKeyId: requireSecret(env, "SENDBLUE_API_KEY_ID"),
    apiSecretKey: requireSecret(env, "SENDBLUE_API_SECRET_KEY"),
    fromNumber: requireSecret(env, "SENDBLUE_FROM_NUMBER"),
    baseUrl: env.SENDBLUE_API_BASE_URL ?? "https://api.sendblue.com/api",
  };
}
