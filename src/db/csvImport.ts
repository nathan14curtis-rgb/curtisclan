import { shortDigest } from "../lib/hash";
import type { ParsedCsvRow } from "../import/csvImport";
import { applyCategorization, createTransaction } from "./transactions";
import { listCategories } from "./categories";

export interface CsvImportSummary {
  imported: number;
  skippedDuplicates: number;
  unmatchedCategoryNames: string[];
}

/** csv_import rows have no plaid_txn_id, so idempotency has to be
 * synthesized — re-running the same import (or importing overlapping date
 * ranges from two exports) must not double-insert. */
async function csvIdempotencyKey(accountId: string, row: ParsedCsvRow): Promise<string> {
  const digest = await shortDigest(`${accountId}|${row.postedAt}|${row.amountCents}|${row.rawDescription}`);
  return `csv:${digest}`;
}

/**
 * Loads parsed CSV rows into the ledger (PLAN.md §12 Phase 0). A row whose
 * Category matches an existing category name is categorized immediately
 * with method='human' — importing Simplifi's own category assignment is a
 * human categorization, and per PLAN.md §4.2 this is exactly what's meant
 * to seed merchant_memory so the app starts smart instead of asking about
 * every recurring merchant on day one.
 */
export async function importCsvTransactions(
  db: D1Database,
  householdId: string,
  accountId: string,
  rows: ParsedCsvRow[],
): Promise<CsvImportSummary> {
  const categories = await listCategories(db, householdId);
  const categoryByName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  let imported = 0;
  let skippedDuplicates = 0;
  const unmatchedCategoryNames = new Set<string>();

  for (const row of rows) {
    const idempotencyKey = await csvIdempotencyKey(accountId, row);
    const existing = await db
      .prepare(`SELECT id FROM "transaction" WHERE plaid_txn_id = ?`)
      .bind(idempotencyKey)
      .first<{ id: string }>();
    if (existing) {
      skippedDuplicates++;
      continue;
    }

    const txn = await createTransaction(db, householdId, {
      accountId,
      postedAt: row.postedAt,
      amountCents: row.amountCents,
      rawDescription: row.rawDescription,
      normalizedMerchant: row.normalizedMerchant,
      plaidTxnId: idempotencyKey,
      source: "csv_import",
    });

    if (row.categoryName) {
      const category = categoryByName.get(row.categoryName.toLowerCase());
      if (category) {
        await applyCategorization(db, householdId, txn.id, {
          categoryId: category.id,
          memo: row.memo,
          method: "human",
        });
      } else {
        unmatchedCategoryNames.add(row.categoryName);
      }
    }

    imported++;
  }

  return { imported, skippedDuplicates, unmatchedCategoryNames: [...unmatchedCategoryNames] };
}
