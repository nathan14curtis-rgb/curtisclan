import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHousehold } from "../src/db/households";
import { createPlaidItem } from "../src/db/plaidItems";
import { getEncryptionKey } from "../src/lib/secrets";
import { listRules } from "../src/db/rules";
import { listTransactions } from "../src/db/transactions";
import { syncPlaidItem } from "../src/plaid/sync";

const db = env.DB;

beforeEach(() => {
  Object.assign(env, {
    PLAID_CLIENT_ID: "test-client-id",
    PLAID_SECRET: "test-secret",
    PLAID_ENV: "sandbox",
    TOKEN_ENCRYPTION_KEY: (() => {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      let binary = "";
      for (const b of raw) binary += String.fromCharCode(b);
      return btoa(binary);
    })(),
  });
});

function mockSyncPage(body: {
  added?: unknown[];
  modified?: unknown[];
  removed?: unknown[];
  accounts?: unknown[];
  has_more?: boolean;
  next_cursor?: string;
}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        added: body.added ?? [],
        modified: body.modified ?? [],
        removed: body.removed ?? [],
        accounts: body.accounts ?? [],
        has_more: body.has_more ?? false,
        next_cursor: body.next_cursor ?? "cursor-1",
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("syncPlaidItem", () => {
  it("seeds the household's default income rule as part of a sync, so the very first backfilled deposit already has somewhere to land", async () => {
    const household = await createHousehold(db, { name: "Curtis Clan" });
    const key = await getEncryptionKey(env);
    const item = await createPlaidItem(db, household.id, { plaidItemId: "plaid-item-1", accessToken: "sandbox-token" }, key);

    expect(await listRules(db, household.id)).toHaveLength(0);

    mockSyncPage({
      accounts: [
        {
          account_id: "plaid-acct-1",
          name: "Checking",
          mask: "1234",
          type: "depository",
          subtype: "checking",
          balances: { current: 5000, available: 4800, iso_currency_code: "USD" },
        },
      ],
      added: [
        {
          transaction_id: "plaid-txn-1",
          account_id: "plaid-acct-1",
          amount: -4710, // dollars, Plaid convention: negative = money in
          iso_currency_code: "USD",
          date: "2026-03-05",
          datetime: null,
          name: "PAYCHECK NORTHWIND INC",
          merchant_name: "NORTHWIND INC",
          pending: false,
          pending_transaction_id: null,
        },
      ],
    });

    await syncPlaidItem(env, household.id, item.plaid_item_id);

    const rules = await listRules(db, household.id);
    expect(rules).toHaveLength(1);
    expect(JSON.parse(rules[0]!.conditions)).toEqual({ field: "amount", op: "gt", value: 0 });

    const transactions = await listTransactions(db, household.id);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.amount_cents).toBe(471000);
  });
});
