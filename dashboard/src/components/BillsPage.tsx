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

export function BillsPage({ householdId, categories, envelopes, envelopeSummaries, transactions, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [detecting, setDetecting] = useState(false);

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

  async function addBill(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createCategory(householdId, {
        name: newName.trim(),
        kind: "expense",
        groupName: "Bills",
        monthlyTargetCents: newTarget.trim() ? Math.round(Number(newTarget) * 100) : undefined,
      });
      setNewName("");
      setNewTarget("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add bill");
    }
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
      </div>

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
                  {summary && <span className="row-meta">{formatCents(summary.spentCents)} spent this month</span>}
                </div>
                <span className={STATUS_BADGE_CLASS[status]}>{status}</span>
                <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                  {bill.monthly_target_cents !== null ? formatCents(bill.monthly_target_cents) : "—"}
                </span>
              </div>
            );
          })}
          {bills.length === 0 && (
            <div className="row-item">
              <span className="hint">No bills yet — group an envelope into "Bills" from Spending Plan, or add one below.</span>
            </div>
          )}
        </div>
      </section>

      <section className="card card--padded">
        <h2>Add a bill</h2>
        <form onSubmit={addBill}>
          <div className="row">
            <input type="text" placeholder="Name (e.g. Mortgage)" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Monthly amount $"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              style={{ width: 180 }}
            />
            <button type="submit">Add</button>
          </div>
        </form>
      </section>

      {error && <p className="error">{error}</p>}
    </div>
  );
}
