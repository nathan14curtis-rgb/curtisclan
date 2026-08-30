import { describe, expect, it } from "vitest";
import { parseCsvAmount, parseCsvDate, parseCsvRows } from "../src/import/csvImport";

describe("parseCsvDate", () => {
  it("accepts ISO dates", () => {
    expect(parseCsvDate("2026-03-01")).toBe("2026-03-01");
  });

  it("converts MM/DD/YYYY", () => {
    expect(parseCsvDate("3/1/2026")).toBe("2026-03-01");
    expect(parseCsvDate("12/25/2026")).toBe("2026-12-25");
  });

  it("rejects an unrecognized format", () => {
    expect(() => parseCsvDate("March 1, 2026")).toThrow();
  });
});

describe("parseCsvAmount", () => {
  it("parses plain and negative amounts", () => {
    expect(parseCsvAmount("45.00")).toBe(4500);
    expect(parseCsvAmount("-45.00")).toBe(-4500);
  });

  it("strips currency formatting", () => {
    expect(parseCsvAmount("$1,234.56")).toBe(123456);
  });

  it("treats accounting-style parentheses as negative", () => {
    expect(parseCsvAmount("(45.00)")).toBe(-4500);
    expect(parseCsvAmount("($1,234.56)")).toBe(-123456);
  });
});

describe("parseCsvRows", () => {
  it("maps a Simplifi-shaped export into transaction-ready rows", () => {
    const rows = parseCsvRows([
      { Date: "3/1/2026", Description: "WALMART #4821 GRAND JCT CO", Category: "Groceries", Amount: "-45.23", Notes: "" },
      { Date: "3/2/2026", Description: "PAYCHECK", Category: "", Amount: "2400.00", Notes: "" },
    ]);

    expect(rows[0]).toMatchObject({
      postedAt: "2026-03-01",
      amountCents: -4523,
      normalizedMerchant: "WALMART",
      categoryName: "Groceries",
    });
    expect(rows[1]).toMatchObject({
      postedAt: "2026-03-02",
      amountCents: 240000,
      categoryName: null,
    });
  });

  it("skips rows with no date (e.g. a trailing balance/summary line)", () => {
    const rows = parseCsvRows([
      { Date: "", Description: "Ending balance", Category: "", Amount: "1000.00", Notes: "" },
      { Date: "3/1/2026", Description: "COFFEE", Category: "", Amount: "-5.00", Notes: "" },
    ]);
    expect(rows).toHaveLength(1);
  });
});
