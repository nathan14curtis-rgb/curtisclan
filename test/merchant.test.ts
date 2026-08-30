import { describe, expect, it } from "vitest";
import { normalizeMerchant } from "../src/lib/merchant";

describe("normalizeMerchant", () => {
  it("collapses store-number variants of the same chain", () => {
    expect(normalizeMerchant("WALMART #4821 GRAND JCT CO")).toBe("WALMART");
    expect(normalizeMerchant("WALMART #0193 DENVER CO")).toBe("WALMART");
  });

  it("strips card-network / processor prefixes", () => {
    expect(normalizeMerchant("SQ *BLUE BOTTLE COFFEE")).toBe("BLUE BOTTLE COFFEE");
    expect(normalizeMerchant("TST* THE HIVE MERCANTILE")).toBe("THE HIVE MERCANTILE");
  });

  it("is case-insensitive and trims whitespace noise", () => {
    expect(normalizeMerchant("  starbucks   #1234 denver co ")).toBe("STARBUCKS");
  });
});
