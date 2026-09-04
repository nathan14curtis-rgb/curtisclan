/**
 * Quiet hours (PLAN.md §5.5): "Queue overnight, send in the morning."
 * Pure time-window logic plus the one household-level rollup that uses it
 * — src/messaging/hourlyCheckin.ts wires that to the actual send/delay
 * decision.
 */
import type { User } from "../types";

export interface QuietHoursWindow {
  start: string; // 'HH:MM', local to the user's timezone
  end: string;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Handles a window that wraps midnight (e.g. 22:00–08:00). A degenerate
 * window (start === end) means "no quiet hours configured". */
export function isWithinQuietHours(hour: number, minute: number, quiet: QuietHoursWindow): boolean {
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const now = hour * 60 + minute;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Minutes from (hour, minute) until the window's end time — always a
 * positive value in [1, 1440]. */
export function minutesUntilQuietHoursEnd(hour: number, minute: number, quiet: QuietHoursWindow): number {
  const now = hour * 60 + minute;
  const end = toMinutes(quiet.end);
  const diff = (end - now + 1440) % 1440;
  return diff === 0 ? 1440 : diff;
}

export function localHourMinute(date: Date, timeZone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24; // Intl can render midnight as "24"
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { hour, minute };
}

/** The household's quiet hours are the union of everyone's — a message
 * that would wake either spouse waits, using whichever of their windows
 * ends latest. A user with no quiet hours configured never blocks it.
 * Returns 0 when it's fine to send right now. */
export function householdQuietDelaySeconds(users: User[], now: Date): number {
  let maxDelaySeconds = 0;
  for (const user of users) {
    if (!user.quiet_hours_start || !user.quiet_hours_end) continue;
    const { hour, minute } = localHourMinute(now, user.timezone);
    const window: QuietHoursWindow = { start: user.quiet_hours_start, end: user.quiet_hours_end };
    if (isWithinQuietHours(hour, minute, window)) {
      maxDelaySeconds = Math.max(maxDelaySeconds, minutesUntilQuietHoursEnd(hour, minute, window) * 60);
    }
  }
  return maxDelaySeconds;
}
