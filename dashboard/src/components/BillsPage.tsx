import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type Category, type Envelope, type EnvelopeMonthSummary, type RecurringPattern, type Transaction } from "../api";
import { formatCents, currentMonth } from "../format";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

type BillStatus = "funded" | "needs funding" | "overspent";

// Bills has no due-date schedule to draw on — there's no recurring-bill
// table, just envelopes grouped "Bills" — so status is derived honestly
// from what the ledger actually knows this month, in different (truthful)
// vocabulary from the design mockup's fabricated scheduled/estimated/paid
// due-date cards.
function billStatus(envelope: Envelope, summary: EnvelopeMonthSummary | undefined): BillStatus {
  if (!summary) return "needs funding";
  if (summary.balanceCents < 0) return "overspent";
  if (envelope.monthly_target_cents && summary.allocatedCents === 0) return "needs funding";
  return "funded";
}

const STATUS_BADGE_CLASS: Record<BillStatus, string> = {
  funded: "badge badge--positive",
  "needs funding": "badge badge--warn",
  overspent: "badge badge--danger",
};

const DAY_SUFFIX = (day: number) => {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
};

function ConfirmPatternForm({
  pattern,
  categories,
  onConfirm,
}: {
  pattern: RecurringPattern;
  categories: Category[];
  onConfirm: (input: { categoryId?: string; newCategoryName?: string; kind?: "expense" | "income" }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [categoryId, setCategoryId] = useState("");
  const [newName, setNewName] = useState("");
  const matchingCategories = categories.filter((c) => !c.archived_at && c.kind === pattern.kind);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "existing") {
      if (!categoryId) return;
      await onConfirm({ categoryId });
    } else {
      if (!newName.trim()) return;
      await onConfirm({ newCategoryName: newName.trim(), kind: pattern.kind });
    }
  }

  return (
    <form className="row" onSubmit={submit} style={{ flex: "0 0 auto" }}>
      <select value={mode} onChange={(e) => setMode(e.target.value as "existing" | "new")}>
        <option value="new">New category</option>
        <option value="existing">Existing category</option>
      </select>
      {mode === "new" ? (
        <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ width: 140 }} required />
      ) : (
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          <option value="" disabled>
            Choose…
          </option>
          {matchingCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
      <button type="submit">Confirm</button>
    </form>
  );
}

type WizardStep = 1 | 2 | 3;

/**
 * "Add recurring" — replaces the old flat "Add a bill" form. Three steps:
 * bill or income, pick (or type) the merchant + day-of-month pattern to
 * auto-match future transactions, then the category and amount. Creates
 * the pattern straight into 'confirmed' (POST .../recurring-patterns) —
 * a person just built it by hand, there's nothing to review.
 */
function AddRecurringWizard({
  categories,
  transactions,
  onCreate,
  onCancel,
}: {
  categories: Category[];
  transactions: Transaction[];
  onCreate: (input: {
    merchantPattern: string;
    kind: "expense" | "income";
    dayOfMonth: number;
    dayTolerance: number;
    categoryId?: string;
    newCategoryName?: string;
    monthlyTargetCents?: number;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<WizardStep>(1);
  const [kind, setKind] = useState<"expense" | "income" | null>(null);
  const [search, setSearch] = useState("");
  const [merchantPattern, setMerchantPattern] = useState("");
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [dayTolerance, setDayTolerance] = useState("4");
  const [categoryMode, setCategoryMode] = useState<"new" | "existing">("new");
  const [categoryId, setCategoryId] = useState("");
  const [newName, setNewName] = useState("");
  const [monthlyTarget, setMonthlyTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchingCategories = useMemo(() => categories.filter((c) => !c.archived_at && c.kind === kind), [categories, kind]);

  const searchResults = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !kind) return [];
    const wantIncome = kind === "income";
    const seenMerchants = new Set<string>();
    const results: Transaction[] = [];
    for (const t of transactions) {
      if (t.is_transfer) continue;
      if (wantIncome ? t.amount_cents <= 0 : t.amount_cents >= 0) continue;
      const merchant = t.normalized_merchant ?? t.raw_description;
      if (!merchant.toLowerCase().includes(needle)) continue;
      if (seenMerchants.has(merchant)) continue;
      seenMerchants.add(merchant);
      results.push(t);
      if (results.length >= 8) break;
    }
    return results;
  }, [search, kind, transactions]);

  function pickTransaction(t: Transaction) {
    setMerchantPattern(t.normalized_merchant ?? t.raw_description);
    setDayOfMonth(String(Number(t.posted_at.slice(8, 10))));
  }

  async function submit() {
    if (!kind || !merchantPattern.trim() || !dayOfMonth) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        merchantPattern: merchantPattern.trim(),
        kind,
        dayOfMonth: Number(dayOfMonth),
        dayTolerance: Number(dayTolerance) || 4,
        categoryId: categoryMode === "existing" ? categoryId : undefined,
        newCategoryName: categoryMode === "new" ? newName.trim() : undefined,
        monthlyTargetCents: kind === "expense" && monthlyTarget.trim() ? Math.round(Number(monthlyTarget) * 100) : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card--padded" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Add recurring — step {step} of 3</h2>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {step === 1 && (
        <div className="row">
          <button
            type="button"
            className={kind === "expense" ? "" : "secondary"}
            onClick={() => {
              setKind("expense");
              setStep(2);
            }}
          >
            Bill (money out)
          </button>
          <button
            type="button"
            className={kind === "income" ? "" : "secondary"}
            onClick={() => {
              setKind("income");
              setStep(2);
            }}
          >
            Income (money in)
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="section" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="rw-search">Search transactions to auto-fill the pattern</label>
            <input id="rw-search" type="text" placeholder="e.g. Lehi City, Netflix…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {searchResults.length > 0 && (
            <div className="row-list">
              {searchResults.map((t) => (
                <div className="row-item" key={t.id} style={{ cursor: "pointer" }} onClick={() => pickTransaction(t)}>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                    <span className="row-meta">{t.posted_at}</span>
                  </div>
                  <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                    {formatCents(t.amount_cents)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="rw-merchant">Merchant pattern (matches any transaction containing this text)</label>
              <input id="rw-merchant" type="text" value={merchantPattern} onChange={(e) => setMerchantPattern(e.target.value)} required />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="rw-day">Day of month</label>
              <input id="rw-day" type="number" min={1} max={31} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} style={{ width: 90 }} required />
            </div>
            <div className="field">
              <label htmlFor="rw-tolerance">± days</label>
              <input id="rw-tolerance" type="number" min={0} max={15} value={dayTolerance} onChange={(e) => setDayTolerance(e.target.value)} style={{ width: 90 }} />
            </div>
          </div>
          <div className="row">
            <button type="button" className="secondary" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(3)} disabled={!merchantPattern.trim() || !dayOfMonth}>
              Next
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="section" style={{ gap: 12 }}>
          <div className="row">
            <select value={categoryMode} onChange={(e) => setCategoryMode(e.target.value as "new" | "existing")}>
              <option value="new">New category</option>
              <option value="existing">Existing category</option>
            </select>
            {categoryMode === "new" ? (
              <input type="text" placeholder="Category name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} required />
            ) : (
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
                <option value="" disabled>
                  Choose…
                </option>
                {matchingCategories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {kind === "expense" && (
            <div className="field" style={{ maxWidth: 220 }}>
              <label htmlFor="rw-amount">Monthly amount budgeted $</label>
              <input id="rw-amount" type="text" inputMode="decimal" value={monthlyTarget} onChange={(e) => setMonthlyTarget(e.target.value)} />
            </div>
          )}
          <div className="row">
            <button type="button" className="secondary" onClick={() => setStep(2)}>
              Back
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || (categoryMode === "new" ? !newName.trim() : !categoryId)}
            >
              {busy ? "Adding…" : "Add recurring"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </section>
  );
}

export function BillsPage({ householdId, categories, envelopes, envelopeSummaries, transactions, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [showWizard, setShowWizard] = useState(false);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const bills = useMemo(
    () => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() === "bills"),
    [envelopes],
  );

  const refreshPatterns = async () => {
    try {
      setPatterns(await api.listRecurringPatterns(householdId));
    } catch (err) {
      // A missing recurring_pattern table (migration 0006 not yet applied
      // on this deployment) shouldn't take the whole page down — bills and
      // add-a-bill still work without it, so just leave the suggested/
      // income sections empty rather than crashing the page.
      console.error("Failed to load recurring patterns:", err);
    }
  };
  useEffect(() => {
    refreshPatterns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  const suggested = useMemo(() => patterns.filter((p) => p.status === "suggested"), [patterns]);
  const confirmedIncome = useMemo(
    () => patterns.filter((p) => p.status === "confirmed" && p.kind === "income" && p.category_id),
    [patterns],
  );

  const month = currentMonth();
  const incomeThisMonthByCategory = useMemo(() => {
    const totals = new Map<string, number>();
    for (const t of transactions) {
      if (t.is_transfer || t.excluded_from_budget || !t.category_id || !t.posted_at.startsWith(month)) continue;
      totals.set(t.category_id, (totals.get(t.category_id) ?? 0) + t.amount_cents);
    }
    return totals;
  }, [transactions, month]);

  async function createRecurring(input: {
    merchantPattern: string;
    kind: "expense" | "income";
    dayOfMonth: number;
    dayTolerance: number;
    categoryId?: string;
    newCategoryName?: string;
    monthlyTargetCents?: number;
  }) {
    await api.createRecurringPattern(householdId, input);
    setShowWizard(false);
    await Promise.all([refreshPatterns(), onChanged()]);
  }

  async function detect() {
    setDetecting(true);
    setError(null);
    try {
      await api.detectRecurringPatterns(householdId);
      await refreshPatterns();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 500
          ? "The recurring-bill detector isn't set up on this deployment yet — the database migration for it (0006_recurring_patterns.sql) needs to be applied. Run `npm run db:migrate:remote`."
          : err instanceof Error
            ? err.message
            : "Failed to look for recurring patterns",
      );
    } finally {
      setDetecting(false);
    }
  }

  async function confirmPattern(pattern: RecurringPattern, input: { categoryId?: string; newCategoryName?: string; kind?: "expense" | "income" }) {
    setError(null);
    try {
      await api.confirmRecurringPattern(householdId, pattern.id, input);
      await Promise.all([refreshPatterns(), onChanged()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm");
    }
  }

  async function dismissPattern(patternId: string) {
    setError(null);
    try {
      await api.dismissRecurringPattern(householdId, patternId);
      await refreshPatterns();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dismiss");
    }
  }

  return (
    <div className="section">
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="secondary" type="button" onClick={detect} disabled={detecting}>
          {detecting ? "Looking…" : "AI Find Bills"}
        </button>
        <button type="button" onClick={() => setShowWizard(true)}>
          Add recurring
        </button>
      </div>

      {showWizard && (
        <AddRecurringWizard categories={categories} transactions={transactions} onCreate={createRecurring} onCancel={() => setShowWizard(false)} />
      )}

      {suggested.length > 0 && (
        <section className="section" style={{ gap: 12 }}>
          <h2 className="section-title" style={{ fontSize: 22 }}>
            Suggested
          </h2>
          <div className="row-list">
            {suggested.map((p) => (
              <div className="row-item" key={p.id}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{p.merchant_pattern}</span>
                  <span className="row-meta">
                    {p.kind === "expense" ? "Charge" : "Deposit"} around the {p.day_of_month}
                    {DAY_SUFFIX(p.day_of_month)} · seen {p.sample_count} times
                  </span>
                </div>
                <span className="badge badge--muted">{p.kind}</span>
                <ConfirmPatternForm pattern={p} categories={categories} onConfirm={(input) => confirmPattern(p, input)} />
                <button className="danger" type="button" onClick={() => dismissPattern(p.id)}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="section" style={{ gap: 12 }}>
        <h2 className="section-title" style={{ fontSize: 22 }}>
          Income
        </h2>
        <div className="row-list">
          {confirmedIncome.map((p) => {
            const category = categoryById.get(p.category_id!);
            return (
              <div className="row-item" key={p.id}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{category?.name ?? p.merchant_pattern}</span>
                  <span className="row-meta">
                    {p.merchant_pattern} · around the {p.day_of_month}
                    {DAY_SUFFIX(p.day_of_month)}
                  </span>
                </div>
                <span className="money positive" style={{ minWidth: 96, textAlign: "right" }}>
                  {formatCents(incomeThisMonthByCategory.get(p.category_id!) ?? 0)}
                </span>
              </div>
            );
          })}
          {confirmedIncome.length === 0 && (
            <div className="row-item">
              <span className="hint">No recurring income confirmed yet — check "Suggested" above once a paycheck or deposit has repeated a few times.</span>
            </div>
          )}
        </div>
      </section>

      <section className="section" style={{ gap: 12 }}>
        <h2 className="section-title" style={{ fontSize: 22 }}>
          Bills
        </h2>
        <div className="row-list">
          {bills.map((bill) => {
            const category = categoryById.get(bill.category_id);
            const summary = envelopeSummaries[bill.id];
            const status = billStatus(bill, summary);
            return (
              <div className="row-item" key={bill.id}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{category?.name ?? "Unknown bill"}</span>
                  <span className="row-meta">{bill.monthly_target_cents !== null ? `${formatCents(bill.monthly_target_cents)} budgeted / mo` : "No monthly amount set"}</span>
                </div>
                <span className={STATUS_BADGE_CLASS[status]}>{status}</span>
                <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                  {summary ? formatCents(summary.spentCents) : formatCents(0)} spent
                </span>
              </div>
            );
          })}
          {bills.length === 0 && (
            <div className="row-item">
              <span className="hint">No bills yet — use "Add recurring" above, or group an envelope into "Bills" from Spending Plan.</span>
            </div>
          )}
        </div>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
