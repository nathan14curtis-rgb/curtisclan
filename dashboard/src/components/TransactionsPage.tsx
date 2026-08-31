import { useMemo, useState } from "react";
import { api, type Account, type Category, type Transaction } from "../api";
import { formatCents } from "../format";

interface Props {
  householdId: string;
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

export function TransactionsPage({ householdId, accounts, categories, transactions, onChanged }: Props) {
  const [accountFilter, setAccountFilter] = useState("");
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Setting busyId re-renders immediately (to disable the control while the
  // request is in flight) but transactions[] — owned by App — doesn't
  // update until onChanged()'s round trip resolves. Without this overlay,
  // that intermediate render forces the checkbox back to its still-stale
  // checked value, visibly reverting the user's own click for a moment.
  const [pendingExcluded, setPendingExcluded] = useState<Record<string, boolean>>({});

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const budgetableCategories = useMemo(() => categories.filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings")), [categories]);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (accountFilter && t.account_id !== accountFilter) return false;
      if (needsReviewOnly && (t.category_id || t.is_transfer)) return false;
      return true;
    });
  }, [transactions, accountFilter, needsReviewOnly]);

  async function setCategory(transactionId: string, categoryId: string) {
    if (!categoryId) return;
    setBusyId(transactionId);
    setError(null);
    try {
      await api.categorizeTransaction(householdId, transactionId, { categoryId });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to categorize");
    } finally {
      setBusyId(null);
    }
  }

  async function toggleExcluded(transactionId: string, excluded: boolean) {
    setPendingExcluded((prev) => ({ ...prev, [transactionId]: excluded }));
    setBusyId(transactionId);
    setError(null);
    try {
      await api.setTransactionExcluded(householdId, transactionId, excluded);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusyId(null);
      setPendingExcluded((prev) => {
        const { [transactionId]: _, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <>
      <h1>Transactions</h1>
      <p className="subtitle">Recategorize, exclude from budget, or just see what came in.</p>

      <section className="card">
        <div className="row">
          <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label className="row" style={{ gap: "0.35rem" }}>
            <input type="checkbox" checked={needsReviewOnly} onChange={(e) => setNeedsReviewOnly(e.target.checked)} />
            <span>Needs review only</span>
          </label>
        </div>
      </section>

      <section className="card" style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--muted)", fontSize: "0.8rem" }}>
              <th style={{ paddingBottom: "0.5rem" }}>Date</th>
              <th>Merchant</th>
              <th>Account</th>
              <th>Amount</th>
              <th>Category</th>
              <th>Exclude</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "0.5rem 0", whiteSpace: "nowrap" }}>{t.posted_at}</td>
                <td>{t.normalized_merchant ?? t.raw_description}</td>
                <td className="hint">{accountById.get(t.account_id)?.name ?? "—"}</td>
                <td className={`money ${t.amount_cents < 0 ? "negative" : "positive"}`} style={{ whiteSpace: "nowrap" }}>
                  {formatCents(t.amount_cents)}
                </td>
                <td>
                  {t.is_transfer ? (
                    <span className="pill">Transfer</span>
                  ) : (
                    <select
                      value={t.category_id ?? ""}
                      disabled={busyId === t.id}
                      onChange={(e) => setCategory(t.id, e.target.value)}
                    >
                      <option value="" disabled>
                        Needs review
                      </option>
                      {budgetableCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={pendingExcluded[t.id] ?? Boolean(t.excluded_from_budget)}
                    disabled={busyId === t.id}
                    onChange={(e) => toggleExcluded(t.id, e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="hint">No transactions match.</p>}
      </section>

      {error && <p className="error">{error}</p>}
    </>
  );
}
