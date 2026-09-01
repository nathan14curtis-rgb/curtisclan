import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { consumeLoginCode, createLoginCode } from "../src/db/loginCodes";

const db = env.DB;
const PHONE = "+13035551234";

async function currentHash(phone: string): Promise<string> {
  const row = await db.prepare(`SELECT code_hash FROM login_code WHERE phone_e164 = ? AND consumed_at IS NULL`).bind(phone).first<{ code_hash: string }>();
  return row!.code_hash;
}

describe("createLoginCode / consumeLoginCode", () => {
  it("the code it sends is exactly the one that consumes successfully", async () => {
    // createLoginCode only returns the plaintext code — recover it by
    // brute-forcing 000000-999999 against the stored hash would be silly;
    // instead read the code back out via a side channel: createLoginCode's
    // return value *is* the plaintext, so just use that directly.
    const code = await createLoginCode(db, PHONE);
    expect(await consumeLoginCode(db, PHONE, code)).toBe("ok");
  });

  it("a code can't be consumed twice", async () => {
    const code = await createLoginCode(db, PHONE);
    expect(await consumeLoginCode(db, PHONE, code)).toBe("ok");
    expect(await consumeLoginCode(db, PHONE, code)).toBe("invalid");
  });

  it("a wrong code is rejected and increments attempts without consuming the real one", async () => {
    const code = await createLoginCode(db, PHONE);
    expect(await consumeLoginCode(db, PHONE, "000000" === code ? "111111" : "000000")).toBe("invalid");
    // The real code still works — a wrong guess doesn't burn the code itself.
    expect(await consumeLoginCode(db, PHONE, code)).toBe("ok");
  });

  it("locks out after 5 wrong attempts, rejecting even the correct code afterward", async () => {
    const code = await createLoginCode(db, PHONE);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      expect(await consumeLoginCode(db, PHONE, wrong)).toBe("invalid");
    }
    expect(await consumeLoginCode(db, PHONE, code)).toBe("too_many_attempts");
  });

  it("a newer code invalidates the previous unconsumed one for the same phone", async () => {
    const first = await createLoginCode(db, PHONE);
    const second = await createLoginCode(db, PHONE);
    expect(first).not.toBe(second);
    expect(await consumeLoginCode(db, PHONE, first)).toBe("invalid");
    expect(await consumeLoginCode(db, PHONE, second)).toBe("ok");
  });

  it("an expired code is rejected even with the right value", async () => {
    const code = await createLoginCode(db, PHONE);
    await db.prepare(`UPDATE login_code SET expires_at = '2000-01-01 00:00:00' WHERE phone_e164 = ? AND consumed_at IS NULL`).bind(PHONE).run();
    expect(await consumeLoginCode(db, PHONE, code)).toBe("expired");
  });

  it("a phone with no code at all returns invalid, not a crash", async () => {
    expect(await consumeLoginCode(db, "+19995551234", "123456")).toBe("invalid");
  });

  it("stores only a hash, never the plaintext code, in the row", async () => {
    const code = await createLoginCode(db, PHONE);
    const hash = await currentHash(PHONE);
    expect(hash).not.toBe(code);
    expect(hash).toHaveLength(64);
  });
});
