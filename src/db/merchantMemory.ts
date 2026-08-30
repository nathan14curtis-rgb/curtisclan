import { newId } from "../lib/id";
import type { MerchantMemory } from "../types";
import { nowIso } from "./client";

export async function getMerchantMemory(
  db: D1Database,
  householdId: string,
  normalizedMerchant: string,
): Promise<MerchantMemory | null> {
  return db
    .prepare(`SELECT * FROM merchant_memory WHERE household_id = ? AND normalized_merchant = ?`)
    .bind(householdId, normalizedMerchant)
    .first<MerchantMemory>();
}

/**
 * Reinforces (or creates) the fast-path memory for a merchant. Only called
 * for human-confirmed categorizations (PLAN.md §6 layer 2: "human-confirmed
 * category"; §9: a dashboard edit "must teach the system exactly as much as
 * one made over text").
 *
 * Also maintains a running mean/stddev of the amount so the cascade can
 * demote to the LLM layer when a new charge is an outlier for this
 * merchant (PLAN.md §6 layer 2 guard) — Welford's online algorithm, so no
 * history of individual amounts needs to be stored.
 */
export async function reinforceMerchantMemory(
  db: D1Database,
  householdId: string,
  normalizedMerchant: string,
  categoryId: string,
  amountCents: number,
): Promise<MerchantMemory> {
  const existing = await getMerchantMemory(db, householdId, normalizedMerchant);
  const now = nowIso();

  if (!existing) {
    const id = newId("mm");
    await db
      .prepare(
        `INSERT INTO merchant_memory
           (id, household_id, normalized_merchant, category_id, hit_count, last_confirmed_at, typical_amount_cents, amount_stddev_cents, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?, ?)`,
      )
      .bind(id, householdId, normalizedMerchant, categoryId, now, amountCents, now, now)
      .run();
    return {
      id,
      household_id: householdId,
      normalized_merchant: normalizedMerchant,
      category_id: categoryId,
      hit_count: 1,
      last_confirmed_at: now,
      typical_amount_cents: amountCents,
      amount_stddev_cents: 0,
      created_at: now,
      updated_at: now,
    };
  }

  // If the category changed, the old average amount no longer describes
  // "typical for this category" — restart the running stats rather than
  // blending two different signals.
  const categoryChanged = existing.category_id !== categoryId;
  const priorCount = categoryChanged ? 0 : existing.hit_count;
  const priorMean = categoryChanged ? 0 : (existing.typical_amount_cents ?? 0);
  const priorVariance = categoryChanged ? 0 : Math.pow(existing.amount_stddev_cents ?? 0, 2);

  const newCount = priorCount + 1;
  const delta = amountCents - priorMean;
  const newMean = priorMean + delta / newCount;
  const newVariance = newCount > 1 ? ((priorCount - 1) * priorVariance + delta * (amountCents - newMean)) / (newCount - 1) : 0;
  const newStddev = Math.round(Math.sqrt(Math.max(newVariance, 0)));

  await db
    .prepare(
      `UPDATE merchant_memory
         SET category_id = ?, hit_count = ?, last_confirmed_at = ?, typical_amount_cents = ?, amount_stddev_cents = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(categoryId, newCount, now, Math.round(newMean), newStddev, now, existing.id)
    .run();

  return {
    ...existing,
    category_id: categoryId,
    hit_count: newCount,
    last_confirmed_at: now,
    typical_amount_cents: Math.round(newMean),
    amount_stddev_cents: newStddev,
    updated_at: now,
  };
}
