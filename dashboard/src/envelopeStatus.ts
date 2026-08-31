import type { Envelope, EnvelopeMonthSummary } from "./api";

export type EnvelopeStatus = "on track" | "tight" | "over";

export function envelopeStatus(envelope: Envelope, summary: EnvelopeMonthSummary | undefined): EnvelopeStatus {
  if (!summary) return "on track";
  if (summary.balanceCents < 0) return "over";
  if (envelope.monthly_target_cents && summary.spentCents >= envelope.monthly_target_cents * 0.85) return "tight";
  return "on track";
}

export const STATUS_BADGE_CLASS: Record<EnvelopeStatus, string> = {
  "on track": "badge",
  tight: "badge badge--warn",
  over: "badge badge--danger",
};
