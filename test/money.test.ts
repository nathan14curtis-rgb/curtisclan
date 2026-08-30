import { describe, expect, it } from "vitest";
import { assertIsCents, centsFromDollarString, formatCents, sumCents } from "../src/lib/money";

describe("centsFromDollarString", () => {
  it("parses plain dollars", () => {
    expect(centsFromDollarString("47")).toBe(4700);
  });

  it("parses dollars and cents", () => {
    expect(centsFromDollarString("47.83")).toBe(4783);
  });

  it("parses negative amounts", () => {
    expect(centsFromDollarString("-12.50")).toBe(-1250);
  });

  it("pads a single fraction digit", () => {
    expect(centsFromDollarString("3.5")).toBe(350);
  });

  it("avoids classic float drift (0.1 + 0.2 style cases)", () => {
    // 29.10 and 0.20 would misbehave under naive parseFloat * 100 rounding.
    expect(centsFromDollarString("29.10")).toBe(2910);
    expect(centsFromDollarString("0.20")).toBe(20);
  });

  it("rejects garbage input", () => {
    expect(() => centsFromDollarString("forty dollars")).toThrow();
    expect(() => centsFromDollarString("12.999")).toThrow();
    expect(() => centsFromDollarString("")).toThrow();
  });
});

describe("formatCents", () => {
  it("formats positive and negative amounts", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
    expect(formatCents(-1200)).toBe("-$12.00");
  });
});

describe("sumCents / assertIsCents", () => {
  it("sums a list of signed cents", () => {
    expect(sumCents(100, -30, 5)).toBe(75);
    expect(sumCents()).toBe(0);
  });

  it("rejects non-integer amounts", () => {
    expect(() => assertIsCents(1.5)).toThrow();
    expect(() => sumCents(100, 2.5)).toThrow();
  });
});
