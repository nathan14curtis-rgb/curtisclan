import { Hono } from "hono";
import { requireParam } from "../lib/http";
import { parseCsvWithHeader } from "../lib/csv";
import { DEFAULT_COLUMN_MAPPING, parseCsvRows, type CsvColumnMapping } from "../import/csvImport";
import { importCsvTransactions } from "../db/csvImport";
import type { Env } from "../types";

export const importRoute = new Hono<{ Bindings: Env }>();

// PLAN.md §12 Phase 0 milestone: "your Simplifi history is queryable in
// your own database." Body is JSON so column mapping travels with the
// file instead of needing a second request.
importRoute.post("/csv", async (c) => {
  const body = await c.req.json<{ accountId?: string; csv?: string; columnMapping?: Partial<CsvColumnMapping> }>();
  if (!body.accountId) return c.json({ error: "accountId is required" }, 400);
  if (!body.csv) return c.json({ error: "csv is required" }, 400);

  const mapping: CsvColumnMapping = { ...DEFAULT_COLUMN_MAPPING, ...body.columnMapping };

  let rows;
  try {
    const records = parseCsvWithHeader(body.csv);
    rows = parseCsvRows(records, mapping);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "failed to parse CSV" }, 400);
  }

  const summary = await importCsvTransactions(c.env.DB, requireParam(c, "householdId"), body.accountId, rows);
  return c.json(summary, 201);
});
