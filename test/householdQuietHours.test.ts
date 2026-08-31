import { describe, expect, it } from "vitest";
import { householdQuietDelaySeconds } from "../src/messaging/sendClarification";
import type { User } from "../src/types";

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "usr_1",
    household_id: "hh_1",
    name: "Nathan",
    phone_e164: "+13035551234",
    phone_verified_at: "2026-01-01 00:00:00",
    timezone: "UTC",
    quiet_hours_start: null,
    quiet_hours_end: null,
    notification_prefs: "{}",
    role: null,
    access_level: "full",
    weekly_allowance_cents: null,
    note: null,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

describe("householdQuietDelaySeconds", () => {
  it("is zero when nobody has quiet hours configured", () => {
    const now = new Date("2026-03-10T23:30:00Z");
    expect(householdQuietDelaySeconds([makeUser(), makeUser({ id: "usr_2" })], now)).toBe(0);
  });

  it("is zero when everyone's quiet hours are configured but nobody is currently in them", () => {
    const now = new Date("2026-03-10T14:00:00Z"); // 2pm UTC, well outside 22:00-08:00
    const users = [makeUser({ quiet_hours_start: "22:00", quiet_hours_end: "08:00" })];
    expect(householdQuietDelaySeconds(users, now)).toBe(0);
  });

  it("delays while at least one household member is in their quiet hours", () => {
    const now = new Date("2026-03-10T23:00:00Z"); // 11pm UTC
    const awake = makeUser({ id: "usr_awake", timezone: "UTC" }); // no quiet hours
    const asleep = makeUser({ id: "usr_asleep", timezone: "UTC", quiet_hours_start: "22:00", quiet_hours_end: "08:00" });
    const delay = householdQuietDelaySeconds([awake, asleep], now);
    expect(delay).toBe(9 * 60 * 60); // 9 hours until 08:00
  });

  it("uses the latest end time across everyone currently in quiet hours", () => {
    const now = new Date("2026-03-10T23:00:00Z"); // 11pm UTC
    const earlyRiser = makeUser({ id: "usr_1", timezone: "UTC", quiet_hours_start: "22:00", quiet_hours_end: "06:00" });
    const lateRiser = makeUser({ id: "usr_2", timezone: "UTC", quiet_hours_start: "21:00", quiet_hours_end: "09:00" });
    const delay = householdQuietDelaySeconds([earlyRiser, lateRiser], now);
    expect(delay).toBe(10 * 60 * 60); // waits for the later of the two: 09:00
  });
});
