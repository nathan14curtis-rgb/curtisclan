import { centsFromDollarString } from "../lib/money";
import { normalizeMerchant } from "../lib/merchant";

/**
 * CSV import (PLAN.md §12 Phase 0: "your Simplifi history is queryable in
 * your own database"). Column names are configurable because the actual
 * Simplifi export format is data only the household has (§13 Q7) — this
 * doesn't assume a specific one, just a reasonable default shape.
 */
export interface CsvColumnMapping {
  date: string;
  description: string;
  amount: string;
  category?: string;
  memo?: string;
}

export const DEFAULT_COLUMN_MAPPING: CsvColumnMapping = {
  date: "Date",
  description: "Description",
  amount: "Amount",
  category: "Category",
  memo: "Notes",
};

export interface ParsedCsvRow {
  postedAt: string; // 'YYYY-MM-DD'
  amountCents: number;
  rawDescription: string;
  normalizedMerchant: string;
  categoryName: string | null;
  memo: string | null;
}

/** Accepts 'YYYY-MM-DD' and 'MM/DD/YYYY' — the two formats a Simplifi or
 * bank export realistically uses. */
export function parseCsvDate(raw: string): string {
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed.slice(0, 10);

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, mm, dd, yyyy] = slash;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }

  throw new Error(`Unrecognized date format: ${JSON.stringify(raw)}`);
}

/** Handles "$1,234.56", "-45.00", and accounting-style "(45.00)" for a
 * negative amount — all three show up across bank/budgeting CSV exports. */
export function parseCsvAmount(raw: string): number {
  const trimmed = raw.trim();
  const negativeParens = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,]/g, "");
  const cents = centsFromDollarString(cleaned);
  return negativeParens ? -Math.abs(cents) : cents;
}

export function parseCsvRows(
  records: Array<Record<string, string>>,
  mapping: CsvColumnMapping = DEFAULT_COLUMN_MAPPING,
): ParsedCsvRow[] {
  return records
    .filter((record) => (record[mapping.date] ?? "").trim() !== "")
    .map((record) => {
      const rawDescription = (record[mapping.description] ?? "").trim();
      const categoryName = mapping.category ? (record[mapping.category] ?? "").trim() || null : null;
      const memo = mapping.memo ? (record[mapping.memo] ?? "").trim() || null : null;
      return {
        postedAt: parseCsvDate(record[mapping.date] ?? ""),
        amountCents: parseCsvAmount(record[mapping.amount] ?? "0"),
        rawDescription,
        normalizedMerchant: normalizeMerchant(rawDescription),
        categoryName,
        memo,
      };
    });
}
