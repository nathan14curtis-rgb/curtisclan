import { describe, expect, it } from "vitest";
import { findTransferMatch, type TransferCandidate } from "../src/categorization/transferDetection";

function candidate(overrides: Partial<TransferCandidate> = {}): TransferCandidate {
  return { id: "txn_a", accountId: "acct_checking", amountCents: -50000, postedAt: "2026-03-10", ...overrides };
}

describe("findTransferMatch", () => {
  it("matches an opposite-signed transaction in a different account within the window", () => {
    const txn = candidate();
    const paymentLeg = candidate({ id: "txn_b", accountId: "acct_amex", amountCents: 50000, postedAt: "2026-03-11" });
    expect(findTransferMatch(txn, [paymentLeg])?.id).toBe("txn_b");
  });

  it("does not match within the same account", () => {
    const txn = candidate();
    const sameAccount = candidate({ id: "txn_b", accountId: "acct_checking", amountCents: 50000 });
    expect(findTransferMatch(txn, [sameAccount])).toBeNull();
  });

  it("does not match a non-cancelling amount", () => {
    const txn = candidate();
    const closeButNotExact = candidate({ id: "txn_b", accountId: "acct_amex", amountCents: 50001 });
    expect(findTransferMatch(txn, [closeButNotExact])).toBeNull();
  });

  it("does not match outside the date window", () => {
    const txn = candidate({ postedAt: "2026-03-01" });
    const tooLate = candidate({ id: "txn_b", accountId: "acct_amex", amountCents: 50000, postedAt: "2026-03-20" });
    expect(findTransferMatch(txn, [tooLate])).toBeNull();
  });

  it("never matches itself", () => {
    const txn = candidate();
    expect(findTransferMatch(txn, [txn])).toBeNull();
  });
});
