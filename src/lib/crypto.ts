/**
 * AES-GCM encryption for Plaid access tokens at rest (PLAN.md §4.1, §10):
 * "a plaintext token column is a full read of every linked account."
 *
 * The key lives in a Workers Secret (never in source, never in D1) and is
 * imported once per request via importEncryptionKey. Each encrypted value
 * gets its own random IV, stored alongside the ciphertext.
 */

const ALGO = "AES-GCM";
const IV_BYTES = 12;

export async function importEncryptionKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  return crypto.subtle.importKey("raw", raw, ALGO, false, ["encrypt", "decrypt"]);
}

export interface EncryptedValue {
  ciphertext: string; // base64
  iv: string; // base64
}

export async function encryptSecret(plaintext: string, key: CryptoKey): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: ALGO, iv }, key, encoded);
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(encrypted: EncryptedValue, key: CryptoKey): Promise<string> {
  const ciphertext = base64ToBytes(encrypted.ciphertext);
  const iv = base64ToBytes(encrypted.iv);
  const plaintext = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
