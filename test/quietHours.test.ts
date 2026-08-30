import { describe, expect, it } from "vitest";
import { isWithinQuietHours, localHourMinute, minutesUntilQuietHoursEnd } from "../src/messaging/quietHours";

const OVERNIGHT = { start: "22:00", end: "08:00" };
const DAYTIME = { start: "13:00", end: "14:00" };

describe("isWithinQuietHours", () => {
  it("handles a same-day window", () => {
    expect(isWithinQuietHours(13, 30, DAYTIME)).toBe(true);
    expect(isWithinQuietHours(12, 59, DAYTIME)).toBe(false);
    expect(isWithinQuietHours(14, 0, DAYTIME)).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    expect(isWithinQuietHours(23, 0, OVERNIGHT)).toBe(true);
    expect(isWithinQuietHours(3, 0, OVERNIGHT)).toBe(true);
    expect(isWithinQuietHours(7, 59, OVERNIGHT)).toBe(true);
    expect(isWithinQuietHours(8, 0, OVERNIGHT)).toBe(false);
    expect(isWithinQuietHours(12, 0, OVERNIGHT)).toBe(false);
  });

  it("treats an equal start/end as no quiet hours configured", () => {
    expect(isWithinQuietHours(3, 0, { start: "09:00", end: "09:00" })).toBe(false);
  });
});

describe("minutesUntilQuietHoursEnd", () => {
  it("computes minutes remaining within a same-day window", () => {
    expect(minutesUntilQuietHoursEnd(13, 30, DAYTIME)).toBe(30);
  });

  it("computes minutes remaining across midnight", () => {
    expect(minutesUntilQuietHoursEnd(23, 0, OVERNIGHT)).toBe(9 * 60);
    expect(minutesUntilQuietHoursEnd(7, 0, OVERNIGHT)).toBe(60);
  });

  it("is a full day when already exactly at the end minute", () => {
    expect(minutesUntilQuietHoursEnd(8, 0, OVERNIGHT)).toBe(1440);
  });
});

describe("localHourMinute", () => {
  it("reads UTC directly", () => {
    const date = new Date("2026-03-10T14:35:00Z");
    expect(localHourMinute(date, "UTC")).toEqual({ hour: 14, minute: 35 });
  });

  it("applies a fixed timezone offset (no DST ambiguity in this fixture)", () => {
    // Denver is UTC-7 in March before the US DST switch.
    const date = new Date("2026-03-01T14:35:00Z");
    expect(localHourMinute(date, "America/Denver")).toEqual({ hour: 7, minute: 35 });
  });
});
