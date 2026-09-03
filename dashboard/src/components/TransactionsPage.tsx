import { useMemo, useState } from "react";
import { api, type Account, type Category, type Transaction, type TransactionFlagColor, type User, type VerifyState } from "../api";
import { dayLabel, formatCents } from "../format";
import { CheckIcon } from "./icons/CheckIcon";
import { PencilIcon } from "./icons/PencilIcon";
import { RobotIcon } from "./icons/RobotIcon";

const FLAG_COLORS: TransactionFlagColor[] = ["red", "orange", "yellow", "green", "blue", "purple"];

interface Props {
  householdId: string;
  currentUserId: string | null;
  users: User[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  onChanged: () => Promise<void>;
}

type VerifyFilter = "all" | "verified" | "unverified";
type SizeFilter = "all" | "under25" | "25to100" | "over100";

const SIZE_FILTER_RANGES: Record<Exclude<SizeFilter, "all">, (cents: number) => boolean> = {
  under25: (cents) => Math.abs(cents) < 2500,
  "25to100": (cents) => Math.abs(cents) >= 2500 && Math.abs(cents) <= 10000,
  over100: (cents) => Math.abs(cents) > 10000,
};

// No glyph for 'me' — the checkbox itself already shows checked, and a
// "✓" badge next to a checked checkbox read as two checkmarks stacked on
// top of each other. The robot icon is the one case worth a badge: it's
// new information (auto-verified, not a person) the checkbox alone can't
// convey.
const VERIFY_MARK: Record<VerifyState, { className: string; label: string; content: React.ReactNode }> = {
  me: { className: "verify-mark verify-mark--me", label: "Verified by a household member", content: null },
  ai: { className: "verify-mark verify-mark--ai", label: "Auto-verified — matched to a known merchant", content: <RobotIcon size={11} /> },
  none: { className: "verify-mark verify-mark--none", label: "Unverified — no one has confirmed this yet", content: null },
};

type QuickFilter = "out" | "in" | "needsCategory" | null;

function initials(text: string): string {
  return text
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function TransactionsPage({ householdId, currentUserId, users, accounts, categories, transactions, onChanged }: Props) {
  const [memberFilter, setMemberFilter] = useState("All");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [merchantQuery, setMerchantQuery] = useState("");
  const [verifyFilter, setVerifyFilter] = useState<VerifyFilter>("all");
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>("all");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftCategoryId, setDraftCategoryId] = useState("");
  const [draftAmount, setDraftAmount] = useState("");
  const [draftExcluded, setDraftExcluded] = useState(false);
  const [flagMenuId, setFlagMenuId] = useState<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // Income is selectable here too — a deposit needs somewhere to land
  // (server-side default: src/categorization/defaultIncomeRule.ts), and a
  // household member should be able to move it from the generic default
  // to something more specific (e.g. "Paycheck") by hand.
  const budgetableCategories = useMemo(
    () => categories.filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings" || c.kind === "income")),
    [categories],
  );

  const memberFor = (t: Transaction) => {
    const ownerId = accountById.get(t.account_id)?.owner_user_id;
    return ownerId ? (userById.get(ownerId)?.name ?? "Shared") : "Shared";
  };

  const filters = ["All", ...users.map((u) => u.name), "Uncategorized"];

  const filtered = useMemo(() => {
    const merchantNeedle = merchantQuery.trim().toLowerCase();
    return transactions.filter((t) => {
      if (memberFilter === "All") {
        // no-op
      } else if (memberFilter === "Uncategorized") {
        if (t.category_id || t.is_transfer) return false;
      } else if (memberFor(t) !== memberFilter) {
        return false;
      }
      if (fromDate && t.posted_at < fromDate) return false;
      if (toDate && t.posted_at > toDate) return false;
      if (merchantNeedle && !(t.normalized_merchant ?? t.raw_description).toLowerCase().includes(merchantNeedle)) return false;
      if (verifyFilter === "verified" && t.verify_state !== "me") return false;
      if (verifyFilter === "unverified" && t.verify_state === "me") return false;
      if (sizeFilter !== "all" && !SIZE_FILTER_RANGES[sizeFilter](t.amount_cents)) return false;
      if (quickFilter === "out" && (t.amount_cents >= 0 || t.is_transfer)) return false;
      if (quickFilter === "in" && (t.amount_cents <= 0 || t.is_transfer)) return false;
      if (quickFilter === "needsCategory" && (t.category_id || t.is_transfer)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, memberFilter, fromDate, toDate, merchantQuery, verifyFilter, sizeFilter, quickFilter, accountById, userById]);

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
        // A transfer's two legs often post on different days (e.g. a card
        // payment initiated one day, credited to the card two days later)
        // — excluded here for the same reason as outCents/inCents below:
        // a lone unmatched leg would otherwise skew that day's net even
        // though no money actually left the household.
        netCents: rows.filter((t) => !t.is_transfer).reduce((sum, t) => sum + t.amount_cents, 0),
      }));
  }, [filtered]);

  // A transfer between two of the household's own accounts (a credit card
  // payment, a savings sweep) shows up twice — once as money leaving one
  // account, once as money landing in the other — so it must never count
  // toward these headline totals or it silently doubles them (a $2,000
  // card payment reads as $2,000 more of both spend and income that never
  // actually happened).
  const nonTransferFiltered = useMemo(() => filtered.filter((t) => !t.is_transfer), [filtered]);
  const outCents = nonTransferFiltered.filter((t) => t.amount_cents < 0).reduce((sum, t) => sum - t.amount_cents, 0);
  const inCents = nonTransferFiltered.filter((t) => t.amount_cents > 0).reduce((sum, t) => sum + t.amount_cents, 0);
  const uncategorizedCount = filtered.filter((t) => !t.category_id && !t.is_transfer).length;

  function startEdit(t: Transaction) {
    setEditingId(t.id);
    setDraftCategoryId(t.category_id ?? "");
    setDraftAmount((t.amount_cents / 100).toFixed(2));
    setDraftExcluded(Boolean(t.excluded_from_budget));
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(t: Transaction) {
    const cents = Math.round(parseFloat(draftAmount) * 100);
    if (!draftCategoryId || Number.isNaN(cents)) {
      setError("Enter a category and a valid amount");
      return;
    }
    setBusyId(t.id);
    setError(null);
    try {
      await api.editTransaction(householdId, t.id, {
        categoryId: draftCategoryId,
        amountCents: cents,
        editedByUserId: currentUserId ?? undefined,
      });
      if (draftExcluded !== Boolean(t.excluded_from_budget)) {
        await api.setTransactionExcluded(householdId, t.id, draftExcluded);
      }
      await onChanged();
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusyId(null);
    }
  }

  async function setFlag(transactionId: string, color: TransactionFlagColor | null) {
    setFlagMenuId(null);
    setBusyId(transactionId);
    setError(null);
    try {
      await api.setTransactionFlag(householdId, transactionId, color);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update flag");
    } finally {
      setBusyId(null);
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

      <div className="row" style={{ gap: 12 }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-from">From</label>
          <input id="tx-filter-from" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-to">To</label>
          <input id="tx-filter-to" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0, flex: "1 1 180px" }}>
          <label htmlFor="tx-filter-merchant">Merchant</label>
          <input
            id="tx-filter-merchant"
            type="text"
            placeholder="Search merchant…"
            value={merchantQuery}
            onChange={(e) => setMerchantQuery(e.target.value)}
          />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-verify">Verification</label>
          <select id="tx-filter-verify" value={verifyFilter} onChange={(e) => setVerifyFilter(e.target.value as VerifyFilter)}>
            <option value="all">All</option>
            <option value="verified">Verified</option>
            <option value="unverified">Unverified</option>
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="tx-filter-size">Size</label>
          <select id="tx-filter-size" value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value as SizeFilter)}>
            <option value="all">Any amount</option>
            <option value="under25">Under $25</option>
            <option value="25to100">$25–$100</option>
            <option value="over100">Over $100</option>
          </select>
        </div>
        {(fromDate || toDate || merchantQuery || verifyFilter !== "all" || sizeFilter !== "all") && (
          <button
            className="secondary"
            type="button"
            style={{ alignSelf: "flex-end" }}
            onClick={() => {
              setFromDate("");
              setToDate("");
              setMerchantQuery("");
              setVerifyFilter("all");
              setSizeFilter("all");
            }}
          >
            Clear filters
          </button>
        )}
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
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "out" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          onClick={() => setQuickFilter((f) => (f === "out" ? null : "out"))}
          onKeyDown={(e) => e.key === "Enter" && setQuickFilter((f) => (f === "out" ? null : "out"))}
        >
          <span className="label">Money out, filtered</span>
          <span className="figure">{formatCents(-outCents)}</span>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "in" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          onClick={() => setQuickFilter((f) => (f === "in" ? null : "in"))}
          onKeyDown={(e) => e.key === "Enter" && setQuickFilter((f) => (f === "in" ? null : "in"))}
        >
          <span className="label">Money in</span>
          <span className="figure" style={{ color: "var(--teal)" }}>
            {formatCents(inCents)}
          </span>
        </div>
        <div
          role="button"
          tabIndex={0}
          className={`card ${quickFilter === "needsCategory" ? "card--emphasis" : ""} card--padded stat-tile`}
          style={{ cursor: "pointer" }}
          onClick={() => setQuickFilter((f) => (f === "needsCategory" ? null : "needsCategory"))}
          onKeyDown={(e) => e.key === "Enter" && setQuickFilter((f) => (f === "needsCategory" ? null : "needsCategory"))}
        >
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
              const isEditing = editingId === t.id;
              const isBusy = busyId === t.id;
              return (
                <div className="row-item" key={t.id}>
                  <div style={{ position: "relative", flex: "0 0 auto" }}>
                    <button
                      type="button"
                      className={`flag-dot ${t.flag_color ? `flag-dot--${t.flag_color}` : ""}`}
                      title={t.flag_color ? `Flagged ${t.flag_color}` : "Flag this transaction"}
                      disabled={isBusy}
                      onClick={() => setFlagMenuId((id) => (id === t.id ? null : t.id))}
                    />
                    {flagMenuId === t.id && (
                      <>
                        <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setFlagMenuId(null)} />
                        <div className="flag-menu">
                          {FLAG_COLORS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              className={`flag-dot flag-dot--${color}`}
                              title={color}
                              onClick={() => setFlag(t.id, color)}
                            />
                          ))}
                          {t.flag_color && (
                            <button type="button" className="flag-dot" title="Clear flag" onClick={() => setFlag(t.id, null)} />
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <span className="row-avatar">{initials(t.normalized_merchant ?? t.raw_description)}</span>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                    <span className="row-meta">{memberFor(t)}</span>
                  </div>
                  {t.is_transfer ? (
                    <span className="badge">transfer</span>
                  ) : isEditing ? (
                    <select value={draftCategoryId} disabled={isBusy} onChange={(e) => setDraftCategoryId(e.target.value)}>
                      <option value="" disabled>
                        Needs review
                      </option>
                      {budgetableCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={`category-chip ${category ? "" : "category-chip--empty"}`}>{category?.name ?? "Needs review"}</span>
                  )}
                  {isEditing ? (
                    <input
                      type="number"
                      step="0.01"
                      className="amount-edit-input"
                      value={draftAmount}
                      disabled={isBusy}
                      onChange={(e) => setDraftAmount(e.target.value)}
                    />
                  ) : (
                    <span className={`money ${t.amount_cents < 0 ? "" : "positive"}`} style={{ minWidth: 96, textAlign: "right" }}>
                      {formatCents(t.amount_cents)}
                    </span>
                  )}
                  <span className={mark.className} title={mark.label} style={{ flex: "0 0 auto" }}>
                    {mark.content}
                  </span>
                  {!t.is_transfer &&
                    (isEditing ? (
                      <div className="row" style={{ gap: 8, flex: "0 0 auto" }}>
                        <label className="row" style={{ gap: 4, fontSize: 12 }} title="Exclude from budget">
                          <input
                            type="checkbox"
                            checked={draftExcluded}
                            disabled={isBusy}
                            onChange={(e) => setDraftExcluded(e.target.checked)}
                          />
                          Exclude
                        </label>
                        <button type="button" className="row-edit-btn" title="Cancel" onClick={cancelEdit} disabled={isBusy}>
                          ×
                        </button>
                        <button
                          type="button"
                          className="row-edit-btn row-edit-btn--save"
                          title="Save"
                          disabled={isBusy}
                          onClick={() => saveEdit(t)}
                        >
                          <CheckIcon size={14} color="#ffffff" />
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="row-edit-btn" title="Edit" onClick={() => startEdit(t)}>
                        <PencilIcon size={14} />
                      </button>
                    ))}
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
