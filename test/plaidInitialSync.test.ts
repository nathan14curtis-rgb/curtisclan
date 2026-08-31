import { describe, expect, it } from "vitest";
import { isInitialPlaidSync } from "../src/plaid/sync";

describe("isInitialPlaidSync", () => {
  // The exact bug this pins down: a newly-linked item's cursor is null
  // (src/db/plaidItems.ts's createPlaidItem) until its first successful
  // /transactions/sync page. Flip this predicate and every historical
  // transaction from a fresh Plaid Link goes back to texting the
  // household individually about charges from months or years ago.
  it("is true for a never-synced item (null cursor)", () => {
    expect(isInitialPlaidSync(null)).toBe(true);
  });

  it("is false once the item has a real cursor from a prior sync", () => {
    expect(isInitialPlaidSync("some-opaque-plaid-cursor-value")).toBe(false);
  });
});
