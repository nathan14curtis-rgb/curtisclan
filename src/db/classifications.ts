import { newId } from "../lib/id";
import type { ClassificationMethod, TransactionClassification } from "../types";
import { nowIso } from "./client";

export interface RecordClassificationInput {
  transactionId: string;
  method: ClassificationMethod;
  categoryId: string | null;
  priorCategoryId?: string | null;
  confidence?: number | null;
  model?: string | null;
  reasoning?: string | null;
  alternatives?: unknown; // serialized to JSON
  promptVersion?: string | null;
  ruleId?: string | null;
  createdByUserId?: string | null;
}

/** Every categorization — rule, memory, LLM, or human — writes one of
 * these. This is both the audit trail and the eval set (PLAN.md §3, §6):
 * "without it you can't answer 'did categorization improve after I
 * changed the prompt?'" */
export async function recordClassification(
  db: D1Database,
  householdId: string,
  input: RecordClassificationInput,
): Promise<TransactionClassification> {
  const id = newId("cls");
  const now = nowIso();
  const alternativesJson = input.alternatives !== undefined ? JSON.stringify(input.alternatives) : null;

  await db
    .prepare(
      `INSERT INTO transaction_classification
         (id, household_id, transaction_id, method, category_id, confidence, model, reasoning, alternatives, prompt_version, rule_id, prior_category_id, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      householdId,
      input.transactionId,
      input.method,
      input.categoryId,
      input.confidence ?? null,
      input.model ?? null,
      input.reasoning ?? null,
      alternativesJson,
      input.promptVersion ?? null,
      input.ruleId ?? null,
      input.priorCategoryId ?? null,
      input.createdByUserId ?? null,
      now,
    )
    .run();

  return {
    id,
    household_id: householdId,
    transaction_id: input.transactionId,
    method: input.method,
    category_id: input.categoryId,
    confidence: input.confidence ?? null,
    model: input.model ?? null,
    reasoning: input.reasoning ?? null,
    alternatives: alternativesJson,
    prompt_version: input.promptVersion ?? null,
    rule_id: input.ruleId ?? null,
    prior_category_id: input.priorCategoryId ?? null,
    created_by_user_id: input.createdByUserId ?? null,
    created_at: now,
  };
}

export async function listClassifications(
  db: D1Database,
  householdId: string,
  transactionId: string,
): Promise<TransactionClassification[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM transaction_classification WHERE household_id = ? AND transaction_id = ? ORDER BY created_at`,
    )
    .bind(householdId, transactionId)
    .all<TransactionClassification>();
  return results;
}
