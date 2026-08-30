/**
 * Collapses a raw bank/card description into a stable key for
 * merchant_memory and the rules engine — "WALMART #4821 GRAND JCT CO" and
 * "WALMART #0193 DENVER CO" should both land on WALMART, or repeat visits
 * to the same chain never warm up layer 2 of the cascade (PLAN.md §6).
 *
 * Deliberately simple (uppercase, strip trailing store numbers / city-state
 * suffixes / card-network noise) rather than a lookup table — Plaid's own
 * `merchant_name` field (Phase 1) will supersede this for synced
 * transactions; this mainly matters for CSV-imported history that only has
 * a raw description.
 */
export function normalizeMerchant(rawDescription: string): string {
  let text = rawDescription.toUpperCase().trim();

  // Card-network / processor prefixes.
  text = text.replace(/^(SQ|TST|PAYPAL|POS|DEBIT|PURCHASE|CHECKCARD)\s*[*:]?\s*/, "");

  // Trailing "CITY ST" / "CITY NAME ST" (city word(s) + two-letter state),
  // stripped before the store-number pass below so a store number sitting
  // between the merchant name and the city ("#4821 GRAND JCT CO") doesn't
  // block the match.
  text = text.replace(/\s+([A-Z]+\s+){1,2}[A-Z]{2}$/, "");
  // Lone trailing state code with no city word in front of it.
  text = text.replace(/\s+[A-Z]{2}$/, "");

  // Trailing store/reference numbers ("#4821", "#0193-A").
  text = text.replace(/\s*#[\dA-Z-]+$/, "");

  // Trailing long digit runs (phone numbers, terminal ids).
  text = text.replace(/\s+\d{4,}$/, "");

  return text.replace(/\s+/g, " ").trim();
}
