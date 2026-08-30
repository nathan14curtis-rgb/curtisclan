import { describe, expect, it } from "vitest";
import { computeEnvelopeBalance, computeReadyToAssign, netSpendCents } from "../src/envelopes/ledger";

describe("computeEnvelopeBalance", () => {
  it("carries allocations minus spend, matching PLAN.md §3's recurrence", () => {
    // balance(month) = balance(month-1) + Σ allocations(month) − Σ spending(month),
    // expressed here as the telescoped running total.
    expect(computeEnvelopeBalance([50000], [12000])).toBe(38000);
  });

  it("carries overspending as a negative balance (PLAN.md §8.2: carry forward)", () => {
    // March: $40 allocated, $80 spent → -$40 into April.
    const marchBalance = computeEnvelopeBalance([4000], [8000]);
    expect(marchBalance).toBe(-4000);
    // April: another $40 allocated, nothing spent yet → still -$0, i.e. the
    // deficit persists until funded back.
    const aprilBalance = computeEnvelopeBalance([4000, 4000], [8000]);
    expect(aprilBalance).toBe(0);
  });
});

describe("netSpendCents", () => {
  it("turns negative (spend) transaction amounts into a positive spend total", () => {
    expect(netSpendCents([-3500, -2500, -1400])).toBe(7400);
  });

  it("nets a refund against spend instead of counting it as income (PLAN.md §3)", () => {
    // $80 grocery run, then a $15 refund on part of it.
    expect(netSpendCents([-8000, 1500])).toBe(6500);
  });

  it("is zero for no transactions", () => {
    expect(netSpendCents([])).toBe(0);
  });
});

describe("computeReadyToAssign", () => {
  it("matches the PLAN.md §8.3.1 walkthrough exactly", () => {
    // Chase checking: $1,000. Spend $80 on Amex for groceries — envelope
    // drops to $520, checking is untouched. Without the correction, Ready
    // to Assign would show $80 that's already been spent.
    const readyToAssign = computeReadyToAssign(
      [100000], // depository: $1,000 checking
      [8000], // credit card: $80 owed on Amex
      [52000], // envelope balances: Groceries at $520 (among others, simplified to one envelope here)
    );
    // cash on hand = 100000 - 8000 = 92000; minus envelope balances = 92000 - 52000 = 40000
    expect(readyToAssign).toBe(40000);
  });

  it("does not let an unpaid card balance inflate Ready to Assign", () => {
    // Before the Amex charge: $1,000 checking, $0 owed, $600 in envelopes.
    const before = computeReadyToAssign([100000], [0], [60000]);
    // After: spend $80 on Amex from Groceries — envelope down to $520,
    // card now owes $80, checking unchanged.
    const after = computeReadyToAssign([100000], [8000], [52000]);
    // Ready to Assign must be unchanged by a pure card purchase — no cash
    // moved, so nothing became newly available to assign.
    expect(after).toBe(before);
  });

  it("supports multiple accounts of each type", () => {
    expect(computeReadyToAssign([50000, 20000], [3000, 5000], [10000])).toBe(52000);
  });
});
