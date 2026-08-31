/**
 * Formats a thrown value for a log line. Workers Logs drops `.message`
 * when an Error is passed as a secondary console.error argument (only
 * `.stack` survives) — so this inlines the actual message (and status/type
 * for API errors like Anthropic's APIError or SendblueApiError) directly
 * into the string instead of relying on the platform to serialize it.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const extra: string[] = [];
    if ("status" in err && err.status !== undefined) extra.push(`status=${(err as { status: unknown }).status}`);
    if ("type" in err && (err as { type: unknown }).type) extra.push(`type=${(err as { type: unknown }).type}`);
    const suffix = extra.length ? ` (${extra.join(", ")})` : "";
    return `${err.name}: ${err.message}${suffix}`;
  }
  return String(err);
}
