import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createHousehold } from "../src/db/households";
import { createUser } from "../src/db/users";
import { createAccount } from "../src/db/accounts";
import { listCategories } from "../src/db/categories";
import { applyCategorization, createTransaction, deleteTransaction, getTransaction, splitTransaction, updateTransaction } from "../src/db/transactions";
import { createTag, deleteTag, listTags, listTagsByTransaction, listTagsForTransaction, setTransactionTags } from "../src/db/tags";
import { NotFoundError } from "../src/db/client";

const db = env.DB;

async function seed() {
  const household = await createHousehold(db, { name: "Curtis Clan" });
  const nathan = await createUser(db, household.id, { name: "Nathan" });
  const checking = await createAccount(db, household.id, { name: "Chase Checking", type: "depository_checking" });
  const savings = await createAccount(db, household.id, { name: "Ally Savings", type: "depository_savings" });
  const categories = await listCategories(db, household.id);
  const groceries = categories.find((c) => c.name === "Groceries")!;
  const dining = categories.find((c) => c.name === "Dining Out")!;
  return { household, nathan, checking, savings, groceries, dining };
}

describe("updateTransaction — the detail modal's one save", () => {
  it("writes every field together and counts as a human verification", async () => {
    const { household, nathan, checking, savings, groceries, dining } = await seed();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id,
      postedAt: "2026-09-04",
      amountCents: -4523,
      rawDescription: "WM SUPERCENTER #1234",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "llm" });

    const updated = await updateTransaction(db, household.id, txn.id, {
      payee: "Walmart",
      postedAt: "2026-09-05",
      amountCents: -5000,
      accountId: savings.id,
      categoryId: dining.id,
      memo: "birthday cake",
      flagColor: "purple",
      excluded: true,
      editedByUserId: nathan.id,
    });

    expect(updated.normalized_merchant).toBe("Walmart");
    expect(updated.posted_at).toBe("2026-09-05");
    expect(updated.amount_cents).toBe(-5000);
    expect(updated.account_id).toBe(savings.id);
    expect(updated.category_id).toBe(dining.id);
    expect(updated.memo).toBe("birthday cake");
    expect(updated.flag_color).toBe("purple");
    expect(updated.excluded_from_budget).toBe(1);
    expect(updated.verified_by_user_id).toBe(nathan.id);
    // The bank's own text is never overwritten by a payee rename.
    expect(updated.raw_description).toBe("WM SUPERCENTER #1234");
  });

  it("leaves omitted fields alone but honors an explicit null", async () => {
    const { household, checking, groceries } = await seed();
    const txn = await createTransaction(db, household.id, {
      accountId: checking.id,
      postedAt: "2026-09-04",
      amountCents: -4523,
      rawDescription: "WALMART",
    });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, memo: "keep me", method: "human" });
    await updateTransaction(db, household.id, txn.id, { flagColor: "red" });

    const untouched = await updateTransaction(db, household.id, txn.id, { amountCents: -4600 });
    expect(untouched.memo).toBe("keep me");
    expect(untouched.flag_color).toBe("red");
    expect(untouched.category_id).toBe(groceries.id);

    const cleared = await updateTransaction(db, household.id, txn.id, { memo: null, flagColor: null });
    expect(cleared.memo).toBeNull();
    expect(cleared.flag_color).toBeNull();
  });

  it("records a classification audit row when the category changes", async () => {
    const { household, nathan, checking, groceries, dining } = await seed();
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -4523, rawDescription: "WALMART" });
    await applyCategorization(db, household.id, txn.id, { categoryId: groceries.id, method: "llm" });
    await updateTransaction(db, household.id, txn.id, { categoryId: dining.id, editedByUserId: nathan.id });

    // Both rows can land in the same second, so identify the human one by
    // what it says rather than by ordering.
    const { results } = await db
      .prepare(`SELECT method, category_id, prior_category_id FROM transaction_classification WHERE transaction_id = ?`)
      .bind(txn.id)
      .all<{ method: string; category_id: string; prior_category_id: string | null }>();
    const human = results.find((r) => r.method === "human");
    expect(human).toBeDefined();
    expect(human!.category_id).toBe(dining.id);
    expect(human!.prior_category_id).toBe(groceries.id);
  });
});

describe("deleteTransaction", () => {
  it("takes its split children with it", async () => {
    const { household, checking, groceries, dining } = await seed();
    const parent = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -10000, rawDescription: "COSTCO" });
    await splitTransaction(db, household.id, parent.id, [
      { amountCents: -6000, categoryId: groceries.id },
      { amountCents: -4000, categoryId: dining.id },
    ]);

    await deleteTransaction(db, household.id, parent.id);
    await expect(getTransaction(db, household.id, parent.id)).rejects.toBeInstanceOf(NotFoundError);
    const { results } = await db.prepare(`SELECT id FROM "transaction" WHERE split_parent_id = ?`).bind(parent.id).all();
    expect(results).toHaveLength(0);
  });

  it("refuses to delete another household's transaction", async () => {
    const { household, checking } = await seed();
    const other = await createHousehold(db, { name: "Someone Else" });
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -100, rawDescription: "X" });
    await expect(deleteTransaction(db, other.id, txn.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getTransaction(db, household.id, txn.id)).id).toBe(txn.id);
  });
});

describe("tags", () => {
  it("settles two racing creates of the same name onto one tag", async () => {
    const { household } = await seed();
    const first = await createTag(db, household.id, { name: "vacation" });
    const second = await createTag(db, household.id, { name: "vacation" });
    expect(second.id).toBe(first.id);
    expect(await listTags(db, household.id)).toHaveLength(1);
  });

  it("replaces a transaction's whole tag set, creating tags typed by name", async () => {
    const { household, checking } = await seed();
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -100, rawDescription: "X" });
    const reimbursable = await createTag(db, household.id, { name: "reimbursable" });

    const applied = await setTransactionTags(db, household.id, txn.id, { tagIds: [reimbursable.id], tagNames: ["vacation"] });
    expect(applied.map((t) => t.name)).toEqual(["reimbursable", "vacation"]);

    // A set, not a diff: passing only one drops the other.
    const narrowed = await setTransactionTags(db, household.id, txn.id, { tagIds: [reimbursable.id] });
    expect(narrowed.map((t) => t.name)).toEqual(["reimbursable"]);
  });

  it("refuses to file another household's tag onto a transaction", async () => {
    const { household, checking } = await seed();
    const other = await createHousehold(db, { name: "Someone Else" });
    const theirs = await createTag(db, other.id, { name: "theirs" });
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -100, rawDescription: "X" });

    expect(await setTransactionTags(db, household.id, txn.id, { tagIds: [theirs.id] })).toEqual([]);
  });

  it("unfiles a deleted tag from every transaction", async () => {
    const { household, checking } = await seed();
    const txn = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -100, rawDescription: "X" });
    const tag = await createTag(db, household.id, { name: "vacation" });
    await setTransactionTags(db, household.id, txn.id, { tagIds: [tag.id] });

    await deleteTag(db, household.id, tag.id);
    expect(await listTagsForTransaction(db, household.id, txn.id)).toEqual([]);
  });

  it("returns every transaction's tags in one read", async () => {
    const { household, checking } = await seed();
    const a = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-04", amountCents: -100, rawDescription: "A" });
    const b = await createTransaction(db, household.id, { accountId: checking.id, postedAt: "2026-09-05", amountCents: -200, rawDescription: "B" });
    await setTransactionTags(db, household.id, a.id, { tagNames: ["vacation"] });
    await setTransactionTags(db, household.id, b.id, { tagNames: ["vacation", "reimbursable"] });

    const byTransaction = await listTagsByTransaction(db, household.id);
    expect(byTransaction[a.id]!.map((t) => t.name)).toEqual(["vacation"]);
    expect(byTransaction[b.id]!.map((t) => t.name)).toEqual(["reimbursable", "vacation"]);
  });
});
