export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Days remaining in the current month, counting today — matches the
 * mockup's "Month status" sidebar widget ("N days left ... before the
 * 1st"). */
export function daysLeftInMonth(now = new Date()): number {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return lastDay - now.getDate() + 1;
}

/** "Today" / "Yesterday" / "August 28" — groups the Transactions list by
 * day the way the mockup does, from a 'YYYY-MM-DD' posted_at string. */
export function dayLabel(dateStr: string, now = new Date()): string {
  const d = new Date(`${dateStr}T00:00:00`);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}
