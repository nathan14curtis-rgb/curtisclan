/**
 * Quiet hours (PLAN.md §5.5): "Queue overnight, send in the morning."
 * Pure time-window logic — src/messaging/sendClarification.ts wires this
 * to the actual send/delay decision.
 */
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
