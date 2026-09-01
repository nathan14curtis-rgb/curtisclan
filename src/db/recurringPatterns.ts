import { newId } from "../lib/id";
import type { RecurringPattern, RecurringPatternKind, RecurringPatternStatus } from "../types";
import { nowIso } from "./client";

const MIN_OCCURRENCES = 2;
const MIN_DISTINCT_MONTHS = 2;
const DEFAULT_DAY_TOLERANCE = 4;
const LOOKBACK_MONTHS = 6;

export async function listRecurringPatterns(
  db: D1Database,
  householdId: string,
  filter: { status?: RecurringPatternStatus } = {},
): Promise<RecurringPattern[]> {
  const clauses = ["household_id = ?"];
  const params: unknown[] = [householdId];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE ${clauses.join(" AND ")} ORDER BY day_of_month, created_at`)
    .bind(...params)
    .all<RecurringPattern>();
  return results;
}

function dayOfMonth(postedAt: string): number {
  return Number(postedAt.slice(8, 10));
}

function monthKey(postedAt: string): string {
  return postedAt.slice(0, 7);
}

/** Circular distance between two days-of-month over a ~30-day month —
 * "the 30th" and "the 1st" are 2 days apart, not 29, so a bill that lands
 * right at month-end doesn't get treated as a mismatch every other month. */
function dayDistance(a: number, b: number, monthLength = 30): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, monthLength - diff);
}

interface DetectableTransaction {
  normalized_merchant: string | null;
  raw_description: string;
  amount_cents: number;
  posted_at: string;
}

function merchantKey(t: DetectableTransaction): string {
  return (t.normalized_merchant ?? t.raw_description).trim().toUpperCase();
}

/**
 * Vendor + day-of-month recurrence, not exact amount — a utility bill that's
 * $200 one month and $240 the next from the same merchant around the same
 * day is still the same recurring bill (and the same shape applies to
 * recurring income, e.g. a paycheck). Scans the household's own history
 * rather than requiring the person to describe the pattern up front; run
 * after a Plaid sync (src/plaid/sync.ts) and on demand from the Recurring
 * page. Never touches a merchant+kind combo that already has a pattern row
 * (suggested, confirmed, or dismissed) — dismissing a false positive once
 * should stick, not get re-suggested on the next sync.
 */
export async function detectRecurringPatterns(db: D1Database, householdId: string): Promise<RecurringPattern[]> {
  const since = new Date();
  since.setMonth(since.getMonth() - LOOKBACK_MONTHS);
  const sinceStr = since.toISOString().slice(0, 10);

  const [{ results: transactions }, existing] = await Promise.all([
    db
      .prepare(
        `SELECT normalized_merchant, raw_description, amount_cents, posted_at FROM "transaction"
           WHERE household_id = ? AND is_transfer = 0 AND excluded_from_budget = 0 AND posted_at >= ?`,
      )
      .bind(householdId, sinceStr)
      .all<DetectableTransaction>(),
    listRecurringPatterns(db, householdId),
  ]);

  const alreadyCovered = new Set(existing.map((p) => `${p.merchant_pattern}::${p.kind}`));

  const groups = new Map<string, { kind: RecurringPatternKind; rows: DetectableTransaction[] }>();
  for (const t of transactions) {
    if (t.amount_cents === 0) continue;
    const kind: RecurringPatternKind = t.amount_cents < 0 ? "expense" : "income";
    const key = `${merchantKey(t)}::${kind}`;
    if (alreadyCovered.has(key)) continue;
    const group = groups.get(key) ?? { kind, rows: [] };
    group.rows.push(t);
    groups.set(key, group);
  }

  const now = nowIso();
  const created: RecurringPattern[] = [];
  for (const [key, group] of groups) {
    if (group.rows.length < MIN_OCCURRENCES) continue;
    const distinctMonths = new Set(group.rows.map((t) => monthKey(t.posted_at)));
    if (distinctMonths.size < MIN_DISTINCT_MONTHS) continue;

    const days = group.rows.map((t) => dayOfMonth(t.posted_at)).sort((a, b) => a - b);
    const medianDay = days[Math.floor(days.length / 2)]!;
    const allWithinTolerance = days.every((d) => dayDistance(d, medianDay) <= DEFAULT_DAY_TOLERANCE);
    if (!allWithinTolerance) continue;

    const id = newId("rpat");
    const merchant = key.slice(0, key.lastIndexOf("::"));
    await db
      .prepare(
        `INSERT INTO recurring_pattern (id, household_id, category_id, merchant_pattern, kind, day_of_month, day_tolerance, status, sample_count, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, 'suggested', ?, ?, ?)`,
      )
      .bind(id, householdId, merchant, group.kind, medianDay, DEFAULT_DAY_TOLERANCE, group.rows.length, now, now)
      .run();
    created.push({
      id,
      household_id: householdId,
      category_id: null,
      merchant_pattern: merchant,
      kind: group.kind,
      day_of_month: medianDay,
      day_tolerance: DEFAULT_DAY_TOLERANCE,
      status: "suggested",
      sample_count: group.rows.length,
      created_at: now,
      updated_at: now,
    });
  }
  return created;
}

/**
 * The "Add recurring" wizard's write path — a pattern built by hand from a
 * picked transaction (or typed in directly), already pointed at a
 * category, so it's created straight into 'confirmed' rather than going
 * through the detector's 'suggested' stage first.
 */
export async function createConfirmedRecurringPattern(
  db: D1Database,
  householdId: string,
  input: { categoryId: string; merchantPattern: string; kind: RecurringPatternKind; dayOfMonth: number; dayTolerance?: number },
): Promise<RecurringPattern> {
  const id = newId("rpat");
  const now = nowIso();
  const dayTolerance = input.dayTolerance ?? DEFAULT_DAY_TOLERANCE;
  await db
    .prepare(
      `INSERT INTO recurring_pattern (id, household_id, category_id, merchant_pattern, kind, day_of_month, day_tolerance, status, sample_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 0, ?, ?)`,
    )
    .bind(id, householdId, input.categoryId, input.merchantPattern.trim().toUpperCase(), input.kind, input.dayOfMonth, dayTolerance, now, now)
    .run();
  return {
    id,
    household_id: householdId,
    category_id: input.categoryId,
    merchant_pattern: input.merchantPattern.trim().toUpperCase(),
    kind: input.kind,
    day_of_month: input.dayOfMonth,
    day_tolerance: dayTolerance,
    status: "confirmed",
    sample_count: 0,
    created_at: now,
    updated_at: now,
  };
}

export async function confirmRecurringPattern(db: D1Database, householdId: string, id: string, categoryId: string): Promise<RecurringPattern> {
  const now = nowIso();
  await db
    .prepare(`UPDATE recurring_pattern SET status = 'confirmed', category_id = ?, updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(categoryId, now, id, householdId)
    .run();
  const pattern = await db.prepare(`SELECT * FROM recurring_pattern WHERE id = ? AND household_id = ?`).bind(id, householdId).first<RecurringPattern>();
  if (!pattern) throw new Error(`recurring_pattern ${id} not found`);
  return pattern;
}

export async function dismissRecurringPattern(db: D1Database, householdId: string, id: string): Promise<void> {
  await db
    .prepare(`UPDATE recurring_pattern SET status = 'dismissed', updated_at = ? WHERE id = ? AND household_id = ?`)
    .bind(nowIso(), id, householdId)
    .run();
}

/**
 * The categorization pipeline's first stop (src/categorization/pipeline.ts,
 * ahead of the rules/memory/LLM cascade): "any transaction from Lehi City
 * on that pattern is auto matched to that bill" regardless of the amount —
 * a confirmed recurring pattern is a stronger, human-approved signal than
 * anything the cascade would otherwise produce for that merchant.
 */
export async function matchRecurringPattern(db: D1Database, householdId: string, txn: DetectableTransaction): Promise<string | null> {
  if (txn.amount_cents === 0) return null;
  const kind: RecurringPatternKind = txn.amount_cents < 0 ? "expense" : "income";
  const key = merchantKey(txn);
  const day = dayOfMonth(txn.posted_at);

  const { results } = await db
    .prepare(`SELECT * FROM recurring_pattern WHERE household_id = ? AND status = 'confirmed' AND kind = ? AND category_id IS NOT NULL`)
    .bind(householdId, kind)
    .all<RecurringPattern>();

  const match = results.find((p) => key.includes(p.merchant_pattern) && dayDistance(day, p.day_of_month) <= p.day_tolerance);
  return match?.category_id ?? null;
}
