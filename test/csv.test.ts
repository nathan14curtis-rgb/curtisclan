import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvWithHeader } from "../src/lib/csv";

describe("parseCsv", () => {
  it("parses a simple grid", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields containing commas and escaped quotes", () => {
    expect(parseCsv('Date,Description\n3/1/2026,"Walmart, ""Supercenter"""')).toEqual([
      ["Date", "Description"],
      ["3/1/2026", 'Walmart, "Supercenter"'],
    ]);
  });

  it("handles a quoted field containing a newline", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsvWithHeader", () => {
  it("keys each row by the header row", () => {
    const rows = parseCsvWithHeader("Date,Amount\n2026-03-01,-45.00\n2026-03-02,12.50");
    expect(rows).toEqual([
      { Date: "2026-03-01", Amount: "-45.00" },
      { Date: "2026-03-02", Amount: "12.50" },
    ]);
  });
});
