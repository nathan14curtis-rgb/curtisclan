import { useMemo, useState } from "react";
import { api, type Account, type Category, type Transaction, type User, type VerifyState } from "../api";
import { dayLabel, formatCents } from "../format";
import { RobotIcon } from "./icons/RobotIcon";

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

const VERIFY_MARK: Record<VerifyState, { className: string; label: string; content: React.ReactNode }> = {
  me: { className: "verify-mark verify-mark--me", label: "Verified by a household member", content: "✓" },
  ai: { className: "verify-mark verify-mark--ai", label: "Auto-verified — matched to a known merchant", content: <RobotIcon size={11} /> },
  none: { className: "verify-mark verify-mark--none", label: "Unverified — no one has confirmed this yet", content: null },
};

function initials(text: string): string {
  return text
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function TransactionsPage({ householdId, users, accounts, categories, transactions, onChanged }: Props) {
  const [memberFilter, setMemberFilter] = useState("All");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Setting busyId re-renders immediately (to disable the control while the
  // request is in flight) but transactions[] — owned by App — doesn't
  // update until onChanged()'s round trip resolves. Without this overlay,
  // that intermediate render forces the checkbox back to its still-stale
  // checked value, visibly reverting the user's own click for a moment.
  const [pendingExcluded, setPendingExcluded] = useState<Record<string, boolean>>({});
  const [verifyingTxId, setVerifyingTxId] = useState<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const budgetableCategories = useMemo(() => categories.filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings")), [categories]);

  const memberFor = (t: Transaction) => {
    const ownerId = accountById.get(t.account_id)?.owner_user_id;
    return ownerId ? (userById.get(ownerId)?.name ?? "Shared") : "Shared";
  };

  const filters = ["All", ...users.map((u) => u.name), "Uncategorized"];

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (memberFilter === "All") return true;
      if (memberFilter === "Uncategorized") return !t.category_id && !t.is_transfer;
      return memberFor(t) === memberFilter;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, memberFilter, accountById, userById]);

  const groups = useMemo(() => {
    const byDate = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const list = byDate.get(t.posted_at) ?? [];
      list.push(t);
      byDate.set(t.posted_at, list);
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([date, rows]) => ({
        date,
        rows,
        netCents: rows.reduce((sum, t) => sum + t.amount_cents, 0),
      }));
  }, [filtered]);

  const outCents = filtered.filter((t) => t.amount_cents < 0).reduce((sum, t) => sum - t.amount_cents, 0);
  const inCents = filtered.filter((t) => t.amount_cents > 0).reduce((sum, t) => sum + t.amount_cents, 0);
  const uncategorizedCount = filtered.filter((t) => !t.category_id && !t.is_transfer).length;

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

  async function verifyAs(transactionId: string, userId: string) {
    setVerifyingTxId(null);
    setError(null);
    try {
      await api.verifyTransaction(householdId, transactionId, userId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify");
    }
  }

  async function unverify(transactionId: string) {
    setError(null);
    try {
      await api.unverifyTransaction(householdId, transactionId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unverify");
    }
  }

  function exportCsv() {
    const header = "Date,Merchant,Account,Category,Amount\n";
    const rows = filtered.map((t) => {
      const merchant = (t.normalized_merchant ?? t.raw_description).replace(/"/g, '""');
      const account = accountById.get(t.account_id)?.name ?? "";
      const category = t.category_id ? (categoryById.get(t.category_id)?.name ?? "") : "";
      return `${t.posted_at},"${merchant}",${account},${category},${(t.amount_cents / 100).toFixed(2)}`;
    });
    const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transactions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="section">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row" style={{ background: "var(--surface-emphasis)", borderRadius: "var(--radius-control)", padding: 4, gap: 4 }}>
          {filters.map((label) => (
            <button
              key={label}
              className={label === memberFilter ? "" : "secondary"}
              style={{ border: "none", padding: "8px 14px" }}
              onClick={() => setMemberFilter(label)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <button className="secondary" onClick={exportCsv} type="button">
          Export CSV
        </button>
      </div>

      <div className="row" style={{ justifyContent: "space-between", fontSize: 13, color: "var(--muted)" }}>
        <div className="row" style={{ gap: 24 }}>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--me" style={{ width: 18, height: 18 }}>✓</span>
            verified
          </span>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--ai" style={{ width: 18, height: 18 }}>
              <RobotIcon size={11} />
            </span>
            auto-verified
          </span>
          <span className="row" style={{ gap: 8 }}>
            <span className="verify-mark verify-mark--none" style={{ width: 18, height: 18 }} />
            unverified
          </span>
        </div>
        <span>
          {filtered.length} of {transactions.length} shown
        </span>
      </div>

      <div className="grid-3">
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Money out, filtered</span>
          <span className="figure">{formatCents(-outCents)}</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Money in</span>
          <span className="figure" style={{ color: "var(--teal)" }}>
            {formatCents(inCents)}
          </span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Needs a category</span>
          <span className="figure">{uncategorizedCount}</span>
        </div>
      </div>

      {groups.map((group) => (
        <div key={group.date} className="section" style={{ gap: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--ink)" }}>{dayLabel(group.date)}</span>
            <span className="money" style={{ color: "var(--faint)" }}>
              net {group.netCents >= 0 ? "+" : "−"}
              {formatCents(Math.abs(group.netCents))}
            </span>
          </div>
          <div className="row-list">
            {group.rows.map((t) => {
              const category = t.category_id ? categoryById.get(t.category_id) : null;
              const mark = VERIFY_MARK[t.verify_state];
              return (
                <div className="row-item" key={t.id}>
                  <span className="row-avatar">{initials(t.normalized_merchant ?? t.raw_description)}</span>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                    <span className="row-meta">{memberFor(t)}</span>
                  </div>
                  {t.is_transfer ? (
                    <span className="badge">transfer</span>
                  ) : (
                    <select value={t.category_id ?? ""} disabled={busyId === t.id} onChange={(e) => setCategory(t.id, e.target.value)}>
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
                  <span className={`money ${t.amount_cents < 0 ? "" : "positive"}`} style={{ minWidth: 96, textAlign: "right" }}>
                    {formatCents(t.amount_cents)}
                  </span>
                  {verifyingTxId === t.id ? (
                    <select autoFocus onChange={(e) => e.target.value && verifyAs(t.id, e.target.value)} onBlur={() => setVerifyingTxId(null)} defaultValue="">
                      <option value="" disabled>
                        Verify as…
                      </option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span
                      title={mark.label}
                      className={mark.className}
                      style={{ cursor: "pointer" }}
                      onClick={() => (t.verify_state === "me" ? unverify(t.id) : setVerifyingTxId(t.id))}
                    >
                      {mark.content}
                    </span>
                  )}
                  <label className="row" style={{ gap: 6, flex: "0 0 auto" }}>
                    <input
                      type="checkbox"
                      checked={pendingExcluded[t.id] ?? Boolean(t.excluded_from_budget)}
                      disabled={busyId === t.id}
                      onChange={(e) => toggleExcluded(t.id, e.target.checked)}
                      title="Exclude from budget"
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {filtered.length === 0 && <p className="hint">No transactions match.</p>}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
