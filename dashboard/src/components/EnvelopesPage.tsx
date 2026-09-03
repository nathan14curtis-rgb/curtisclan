import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type Category, type CategorySuggestion, type Envelope, type EnvelopeMonthSummary, type Transaction } from "../api";
import { formatCents, currentMonth } from "../format";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
}

function EnvelopeDrilldown({
  householdId,
  envelope,
  category,
  categories,
  transactions,
  onTransactionsChanged,
  onBalanceAdjusted,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  categories: Category[];
  transactions: Transaction[];
  onTransactionsChanged: () => Promise<void>;
  onBalanceAdjusted: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjusting, setAdjusting] = useState(false);

  const budgetableCategories = useMemo(
    () => categories.filter((c) => !c.archived_at && (c.kind === "expense" || c.kind === "savings" || c.kind === "income")),
    [categories],
  );
  const envelopeTransactions = useMemo(
    () => transactions.filter((t) => t.category_id === envelope.category_id).sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1)),
    [transactions, envelope.category_id],
  );

  async function moveTransaction(transactionId: string, categoryId: string) {
    if (!categoryId || categoryId === envelope.category_id) return;
    setBusyId(transactionId);
    setError(null);
    try {
      await api.categorizeTransaction(householdId, transactionId, { categoryId });
      await onTransactionsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move transaction");
    } finally {
      setBusyId(null);
    }
  }

  async function adjustBalance(e: FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(adjustAmount) * 100);
    if (!Number.isFinite(cents) || cents === 0) return;
    setAdjusting(true);
    setError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, { month: currentMonth(), amountCents: cents, note: adjustNote.trim() || "Manual balance adjustment" });
      setAdjustAmount("");
      setAdjustNote("");
      await onBalanceAdjusted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to adjust balance");
    } finally {
      setAdjusting(false);
    }
  }

  return (
    <div className="card card--padded" style={{ marginTop: -8, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h3 style={{ margin: "0 0 4px" }}>{category?.name ?? "Envelope"} — transactions</h3>
        <p className="hint" style={{ margin: 0 }}>Move a transaction to a different category, or adjust this envelope's balance with a one-time correction.</p>
      </div>

      <div className="row-list">
        {envelopeTransactions.map((t) => (
          <div className="row-item" key={t.id}>
            <div className="row-figure" style={{ flex: "1 1 auto" }}>
              <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
              <span className="row-meta">{t.posted_at}</span>
            </div>
            <span className={`money ${t.amount_cents < 0 ? "" : "positive"}`} style={{ minWidth: 96, textAlign: "right" }}>
              {formatCents(t.amount_cents)}
            </span>
            <select value={envelope.category_id} disabled={busyId === t.id} onChange={(e) => moveTransaction(t.id, e.target.value)}>
              {budgetableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ))}
        {envelopeTransactions.length === 0 && (
          <div className="row-item">
            <span className="hint">No transactions in this envelope yet this period.</span>
          </div>
        )}
      </div>

      <form className="row" onSubmit={adjustBalance}>
        <input
          type="text"
          inputMode="decimal"
          placeholder="Adjust balance by $ (e.g. -25 or 100)"
          value={adjustAmount}
          onChange={(e) => setAdjustAmount(e.target.value)}
          style={{ width: 220 }}
        />
        <input type="text" placeholder="Note (optional)" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" disabled={adjusting}>
          Apply
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface EnvelopeMenuAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon: string;
}

/** The row's "⋮" menu — a small click-away dropdown, no library needed for
 * four to five actions. Closes on an outside click via a full-viewport
 * transparent backdrop rather than a blur handler, so a click that lands on
 * another row's menu button still opens that one instead of just closing
 * this one and requiring a second click. */
function EnvelopeMenu({ actions }: { actions: EnvelopeMenuAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="envelope-menu-button"
        aria-label="Envelope actions"
        onClick={() => setOpen((v) => !v)}
      >
        ⋮
      </button>
      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 19 }}
            onClick={() => setOpen(false)}
          />
          <div className="envelope-menu-dropdown">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="envelope-menu-item"
                disabled={a.disabled}
                style={a.danger ? { color: "var(--red)" } : undefined}
                onClick={() => {
                  setOpen(false);
                  a.onClick();
                }}
              >
                <span aria-hidden style={{ width: 16, textAlign: "center" }}>{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The "Add" button on each Spending Plan summary tab — picks a past
 * transaction and turns it into a confirmed recurring pattern (same write
 * path as the Recurring page's "Add recurring" wizard), so a bill or
 * income deposit someone already has starts auto-matching going forward
 * without a trip to the Recurring page.
 */
function RecurringTransactionPicker({
  householdId,
  kind,
  categories,
  transactions,
  onDone,
  onCancel,
}: {
  householdId: string;
  kind: "expense" | "income";
  categories: Category[];
  transactions: Transaction[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Transaction | null>(null);
  const [merchantPattern, setMerchantPattern] = useState("");
  const [dayOfMonth, setDayOfMonth] = useState("");
  const [categoryMode, setCategoryMode] = useState<"existing" | "new">("new");
  const [categoryId, setCategoryId] = useState("");
  const [newName, setNewName] = useState("");
  const [monthlyTarget, setMonthlyTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matchingCategories = useMemo(() => categories.filter((c) => !c.archived_at && c.kind === kind), [categories, kind]);

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const seen = new Set<string>();
    const results: Transaction[] = [];
    for (const t of transactions) {
      if (t.is_transfer) continue;
      if (kind === "income" ? t.amount_cents <= 0 : t.amount_cents >= 0) continue;
      const merchant = t.normalized_merchant ?? t.raw_description;
      if (needle && !merchant.toLowerCase().includes(needle)) continue;
      if (seen.has(merchant)) continue;
      seen.add(merchant);
      results.push(t);
      if (results.length >= 8) break;
    }
    return results;
  }, [search, kind, transactions]);

  function pick(t: Transaction) {
    setPicked(t);
    setMerchantPattern(t.normalized_merchant ?? t.raw_description);
    setDayOfMonth(String(Number(t.posted_at.slice(8, 10))));
    if (t.category_id) {
      setCategoryMode("existing");
      setCategoryId(t.category_id);
    }
  }

  async function submit() {
    if (!merchantPattern.trim() || !dayOfMonth) return;
    if (categoryMode === "existing" && !categoryId) return;
    if (categoryMode === "new" && !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRecurringPattern(householdId, {
        merchantPattern: merchantPattern.trim(),
        kind,
        dayOfMonth: Number(dayOfMonth),
        categoryId: categoryMode === "existing" ? categoryId : undefined,
        newCategoryName: categoryMode === "new" ? newName.trim() : undefined,
        monthlyTargetCents: kind === "expense" && monthlyTarget.trim() ? Math.round(Number(monthlyTarget) * 100) : undefined,
      });
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add recurring");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card--padded" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Choose a previous transaction to be made recurring</h3>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {!picked ? (
        <div className="section" style={{ gap: 12 }}>
          <input type="text" placeholder="Search transactions…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="row-list">
            {candidates.map((t) => (
              <div className="row-item" key={t.id} style={{ cursor: "pointer" }} onClick={() => pick(t)}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                  <span className="row-meta">{t.posted_at}</span>
                </div>
                <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                  {formatCents(t.amount_cents)}
                </span>
              </div>
            ))}
            {candidates.length === 0 && (
              <div className="row-item">
                <span className="hint">No matching transactions yet.</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="section" style={{ gap: 12 }}>
          <div className="row-item" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-control)" }}>
            <div className="row-figure" style={{ flex: "1 1 auto" }}>
              <span className="row-title">{picked.normalized_merchant ?? picked.raw_description}</span>
              <span className="row-meta">{picked.posted_at}</span>
            </div>
            <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
              {formatCents(picked.amount_cents)}
            </span>
            <button type="button" className="secondary" onClick={() => setPicked(null)}>
              Change
            </button>
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label htmlFor="rtp-merchant">Merchant pattern</label>
              <input id="rtp-merchant" type="text" value={merchantPattern} onChange={(e) => setMerchantPattern(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="rtp-day">Day of month</label>
              <input
                id="rtp-day"
                type="number"
                min={1}
                max={31}
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
                style={{ width: 90 }}
              />
            </div>
          </div>
          <div className="row">
            <select value={categoryMode} onChange={(e) => setCategoryMode(e.target.value as "existing" | "new")}>
              <option value="new">New category</option>
              <option value="existing">Existing category</option>
            </select>
            {categoryMode === "existing" ? (
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
            ) : (
              <input type="text" placeholder="Category name" value={newName} onChange={(e) => setNewName(e.target.value)} style={{ flex: 1 }} />
            )}
            {kind === "expense" && (
              <input
                type="text"
                inputMode="decimal"
                placeholder="Monthly amount $ (optional)"
                value={monthlyTarget}
                onChange={(e) => setMonthlyTarget(e.target.value)}
                style={{ width: 200 }}
              />
            )}
          </div>
          <div className="row">
            <button type="button" onClick={submit} disabled={busy}>
              {busy ? "Adding…" : "Add recurring"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** A Spending Plan section collapsed to one summary row — name, item
 * count, this month's total, and an "Add" button — that expands in place
 * to the full breakdown on click. Keeps Income/Bills/Planned/Other spend
 * scannable at a glance without losing the detail underneath. */
function SummaryTab({
  title,
  itemCountLabel,
  totalCents,
  isExpanded,
  onToggle,
  onAdd,
  children,
}: {
  title: string;
  itemCountLabel: string;
  totalCents: number;
  isExpanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="section" style={{ gap: 12 }}>
      <div className="card card--padded row" style={{ justifyContent: "space-between", cursor: "pointer" }} onClick={onToggle}>
        <div className="row" style={{ gap: 12 }}>
          <span className={`nav-caret ${isExpanded ? "is-open" : ""}`} aria-hidden>
            ›
          </span>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--ink)" }}>{title}</div>
            <p className="hint" style={{ margin: 0 }}>
              {itemCountLabel}
            </p>
          </div>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <span className="money" style={{ fontSize: 18, fontWeight: 600 }}>
            {formatCents(totalCents)}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            Add
          </button>
        </div>
      </div>
      {isExpanded && <div className="section" style={{ gap: 12 }}>{children}</div>}
    </div>
  );
}

interface EditDraft {
  groupName: string;
  target: string;
  targetDate: string;
}

/** One envelope's full row: transaction count + group tag, a bar showing
 * this month's target alongside any rollover sitting on top of it, the
 * available-to-spend figure, and the "⋮" menu (release rollover, edit the
 * target, hand-adjust the rollover, rename the underlying category, or
 * archive it). Bills and "planned"/"other" spend all render through this
 * same row — the only difference between those sections is which envelopes
 * get handed to it. */
function EnvelopeRow({
  householdId,
  envelope,
  category,
  summary,
  month,
  categories,
  transactions,
  isExpanded,
  onToggleExpand,
  draft,
  onStartEdit,
  onDraftChange,
  onSaveEdit,
  onChanged,
  onTransactionsChanged,
  onArchive,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  summary: EnvelopeMonthSummary | undefined;
  month: string;
  categories: Category[];
  transactions: Transaction[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  draft: EditDraft | undefined;
  onStartEdit: () => void;
  onDraftChange: (draft: EditDraft) => void;
  onSaveEdit: () => void;
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
  onArchive: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);

  const target = envelope.monthly_target_cents;
  const balance = summary?.balanceCents ?? 0;
  const spent = summary?.spentCents ?? 0;
  const rolloverCents = target !== null ? balance - target : 0;
  const over = balance < 0;

  const txnCount = useMemo(
    () =>
      transactions.filter(
        (t) => t.category_id === envelope.category_id && !t.is_transfer && !t.excluded_from_budget && t.posted_at.startsWith(month),
      ).length,
    [transactions, envelope.category_id, month],
  );

  async function releaseUnspentFunds() {
    if (rolloverCents <= 0) return;
    setActionError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, {
        month: currentMonth(),
        amountCents: -rolloverCents,
        note: "Released unspent funds",
      });
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to release unspent funds");
    }
  }

  async function changeRolloverAmount() {
    const current = (Math.max(0, rolloverCents) / 100).toFixed(2);
    const input = window.prompt(`Set this envelope's rollover (funds beyond this month's target) to how much?`, current);
    if (input === null) return;
    const desiredRolloverCents = Math.round(Number(input) * 100);
    if (!Number.isFinite(desiredRolloverCents)) return;
    const delta = desiredRolloverCents - Math.max(0, rolloverCents);
    if (delta === 0) return;
    setActionError(null);
    try {
      await api.allocateToEnvelope(householdId, envelope.id, { month: currentMonth(), amountCents: delta, note: "Change rollover amount" });
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to change rollover amount");
    }
  }

  async function editExpenseSeries() {
    if (!category) return;
    const name = window.prompt("Rename this expense", category.name);
    if (!name || !name.trim() || name.trim() === category.name) return;
    setActionError(null);
    try {
      await api.renameCategory(householdId, category.id, name.trim());
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  const barTotal = Math.max(target ?? 0, balance, 1);
  const targetSegPct = target ? (target / barTotal) * 100 : 0;
  const rolloverSegPct = 100 - targetSegPct;
  const fillPct = target ? Math.max(0, Math.min(100, (balance / target) * 100)) : 0;

  return (
    <div>
      <div
        className="row-item"
        style={{ cursor: "pointer", flexWrap: "wrap", rowGap: 10 }}
        onClick={(ev) => {
          if ((ev.target as HTMLElement).closest("button, input, select")) return;
          onToggleExpand();
        }}
      >
        <div className="row-figure" style={{ flex: "1 1 220px", minWidth: 180 }}>
          <span className="row-title">{category?.name ?? "Unknown category"}</span>
          <span className="row-meta" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {txnCount} transaction{txnCount === 1 ? "" : "s"} in:
            <span className="badge badge--soft badge--muted">{envelope.group_name}</span>
            <span aria-hidden title="Rolls over month to month" style={{ color: "var(--faint)" }}>⟲</span>
          </span>
        </div>

        {draft ? (
          <div className="row" style={{ flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
            <input
              type="text"
              placeholder="Group"
              value={draft.groupName}
              onChange={(e) => onDraftChange({ ...draft, groupName: e.target.value })}
              style={{ width: 100 }}
            />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Target $"
              value={draft.target}
              onChange={(e) => onDraftChange({ ...draft, target: e.target.value })}
              style={{ width: 90 }}
            />
            {category?.kind === "savings" && (
              <input type="date" title="Goal date" value={draft.targetDate} onChange={(e) => onDraftChange({ ...draft, targetDate: e.target.value })} />
            )}
            <button className="secondary" onClick={onSaveEdit}>
              Save
            </button>
          </div>
        ) : (
          <>
            <div style={{ flex: "2 1 220px", minWidth: 180, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontFamily: "var(--font-mono)" }}>
                <span>
                  Spent <strong>{formatCents(spent)}</strong>
                </span>
                <span style={{ display: "flex", gap: 8 }}>
                  {target !== null && (
                    <span>
                      of <strong>{formatCents(target)}</strong>
                    </span>
                  )}
                  {rolloverCents > 0 && <span style={{ color: "var(--teal)" }}>+{formatCents(rolloverCents)}</span>}
                </span>
              </div>
              {over ? (
                <div className="envelope-bar">
                  <div className="envelope-bar-target-fill over" style={{ width: "100%" }} />
                </div>
              ) : target !== null ? (
                <div className="envelope-bar">
                  <div className="envelope-bar-target" style={{ width: `${targetSegPct}%` }}>
                    <div className="envelope-bar-target-fill" style={{ width: `${fillPct}%` }} />
                  </div>
                  {rolloverSegPct > 0 && <div className="envelope-bar-rollover" style={{ width: `${rolloverSegPct}%` }} />}
                </div>
              ) : (
                <div className="envelope-bar">
                  {balance > 0 && <div className="envelope-bar-rollover" style={{ width: "100%" }} />}
                </div>
              )}
            </div>

            <div style={{ flex: "0 0 auto", textAlign: "right", minWidth: 130 }}>
              <div className={`money ${over ? "negative" : "positive"}`} style={{ fontSize: 18, fontWeight: 600 }}>
                {formatCents(balance)}
              </div>
              <div className="hint" style={{ margin: 0 }}>
                {over ? "Over budget" : rolloverCents > 0 ? "Available with rollover" : "Available to spend"}
              </div>
            </div>

            <EnvelopeMenu
              actions={[
                {
                  label: "Release unspent funds",
                  icon: "↩",
                  disabled: rolloverCents <= 0,
                  onClick: releaseUnspentFunds,
                },
                { label: "Edit this month's expense", icon: "🗓", onClick: onStartEdit },
                { label: "Change rollover amount", icon: "⇄", onClick: changeRolloverAmount },
                { label: "Edit expense series", icon: "✎", onClick: editExpenseSeries },
                { label: "Archive", icon: "🗄", danger: true, onClick: onArchive },
              ]}
            />
          </>
        )}
      </div>
      {actionError && (
        <div className="row-item">
          <p className="error" style={{ margin: 0 }}>{actionError}</p>
        </div>
      )}
      {isExpanded && (
        <EnvelopeDrilldown
          householdId={householdId}
          envelope={envelope}
          category={category}
          categories={categories}
          transactions={transactions}
          onTransactionsChanged={onTransactionsChanged}
          onBalanceAdjusted={onChanged}
        />
      )}
    </div>
  );
}

export function EnvelopesPage({ householdId, categories, envelopes, envelopeSummaries, transactions, onChanged, onTransactionsChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"expense" | "savings">("expense");
  const [newGroup, setNewGroup] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [editing, setEditing] = useState<Record<string, EditDraft>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<"income" | "bills" | "planned" | "other" | null>(null);
  const [addingTab, setAddingTab] = useState<"income" | "bills" | "planned" | "other" | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<Record<number, boolean>>({});
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const month = currentMonth();

  // Every non-transfer envelope, split three ways for the page's required
  // order (income, then bills, then planned spend, then other spend):
  // Bills already live in their own group_name; "planned" is any envelope
  // with a monthly target set, "other" is everything left (ad hoc spend
  // with no target to plan against yet).
  const bills = useMemo(() => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() === "bills"), [envelopes]);
  const nonBills = useMemo(() => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() !== "bills"), [envelopes]);
  const plannedEnvelopes = useMemo(() => nonBills.filter((e) => e.monthly_target_cents !== null), [nonBills]);
  const otherEnvelopes = useMemo(() => nonBills.filter((e) => e.monthly_target_cents === null), [nonBills]);

  // Flat transactions, not grouped by income category ("Paycheck" vs.
  // "Other Income") — the summary tab just says "Income" and the
  // breakdown is every deposit that landed there this month.
  const incomeTransactions = useMemo(
    () =>
      transactions
        .filter(
          (t) => !t.is_transfer && !t.excluded_from_budget && t.posted_at.startsWith(month) && categoryById.get(t.category_id ?? "")?.kind === "income",
        )
        .sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1)),
    [transactions, categoryById, month],
  );
  const incomeThisMonthCents = useMemo(() => incomeTransactions.reduce((sum, t) => sum + t.amount_cents, 0), [incomeTransactions]);

  const allocatedForSpendCents = useMemo(
    () => plannedEnvelopes.filter((e) => categoryById.get(e.category_id)?.kind === "expense").reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0),
    [plannedEnvelopes, categoryById],
  );
  const allocatedForGoalsCents = useMemo(
    () => plannedEnvelopes.filter((e) => categoryById.get(e.category_id)?.kind === "savings").reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0),
    [plannedEnvelopes, categoryById],
  );
  const billsCommittedCents = useMemo(() => bills.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [bills]);
  const allocatedCents = allocatedForSpendCents + allocatedForGoalsCents;
  const unallocatedCents = incomeThisMonthCents - billsCommittedCents - allocatedCents;
  const otherSpendCents = useMemo(
    () => otherEnvelopes.reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [otherEnvelopes, envelopeSummaries],
  );

  function groupByName(list: Envelope[]) {
    const byGroup = new Map<string, Envelope[]>();
    for (const e of list) {
      const g = byGroup.get(e.group_name) ?? [];
      g.push(e);
      byGroup.set(e.group_name, g);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }
  const groupedPlanned = useMemo(() => groupByName(plannedEnvelopes), [plannedEnvelopes]);
  const groupedOther = useMemo(() => groupByName(otherEnvelopes), [otherEnvelopes]);

  function startEdit(e: Envelope) {
    setEditing((prev) => ({
      ...prev,
      [e.id]: { groupName: e.group_name, target: e.monthly_target_cents ? (e.monthly_target_cents / 100).toString() : "", targetDate: e.target_date ?? "" },
    }));
  }

  async function saveEdit(envelopeId: string) {
    const draft = editing[envelopeId];
    if (!draft) return;
    setError(null);
    try {
      await api.updateEnvelope(householdId, envelopeId, {
        groupName: draft.groupName.trim() || "Uncategorized",
        monthlyTargetCents: draft.target.trim() ? Math.round(Number(draft.target) * 100) : null,
        targetDate: draft.targetDate || null,
      });
      setEditing((prev) => {
        const { [envelopeId]: _, ...rest } = prev;
        return rest;
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update envelope");
    }
  }

  async function archive(categoryId: string) {
    setError(null);
    try {
      await api.archiveCategory(householdId, categoryId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive");
    }
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createCategory(householdId, {
        name: newName.trim(),
        kind: newKind,
        groupName: newGroup.trim() || undefined,
        monthlyTargetCents: newTarget.trim() ? Math.round(Number(newTarget) * 100) : undefined,
      });
      setNewName("");
      setNewTarget("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add category");
    }
  }

  async function loadSuggestions() {
    setSuggestError(null);
    setLoadingSuggestions(true);
    try {
      const results = await api.suggestCategories(householdId);
      setSuggestions(results);
      setSuggestChecked(Object.fromEntries(results.map((_, i) => [i, true])));
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : "Failed to get suggestions");
    } finally {
      setLoadingSuggestions(false);
    }
  }

  // A full rebuild, not "add whatever's new" — archives every current
  // non-Bill category (Bills stays put; it's a separate page's concern now)
  // before creating the checked suggestions, so the spending plan actually
  // matches what was reviewed instead of accumulating both old and new.
  async function rebuildFromSuggestions() {
    if (!suggestions) return;
    const toCreate = suggestions.filter((_, i) => suggestChecked[i]);
    const visibleCategoryIds = new Set(nonBills.map((e) => e.category_id));
    const toArchive = categories.filter((c) => visibleCategoryIds.has(c.id));
    if (
      !window.confirm(
        `This replaces your current spending plan: ${toArchive.length} existing categor${toArchive.length === 1 ? "y" : "ies"} will be archived, then ${toCreate.length} new one${toCreate.length === 1 ? "" : "s"} created. Bills are not affected. Continue?`,
      )
    ) {
      return;
    }
    setSuggestError(null);
    setRebuilding(true);
    try {
      for (const c of toArchive) {
        await api.archiveCategory(householdId, c.id);
      }
      for (const s of toCreate) {
        await api.createCategory(householdId, {
          name: s.name,
          kind: s.kind,
          groupName: s.groupName || undefined,
          monthlyTargetCents: s.monthlyTargetCents ?? undefined,
        });
      }
      setSuggestions(null);
      await onChanged();
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : "Failed to rebuild the spending plan");
    } finally {
      setRebuilding(false);
    }
  }

  function renderEnvelopeGroups(groups: [string, Envelope[]][]) {
    return groups.map(([groupName, groupEnvelopes]) => (
      <div key={groupName} className="section" style={{ gap: 12 }}>
        <p className="envelope-group-heading">{groupName}</p>
        <div className="row-list">
          {groupEnvelopes.map((envelope) => (
            <EnvelopeRow
              key={envelope.id}
              householdId={householdId}
              envelope={envelope}
              category={categoryById.get(envelope.category_id)}
              summary={envelopeSummaries[envelope.id]}
              month={month}
              categories={categories}
              transactions={transactions}
              isExpanded={expandedId === envelope.id}
              onToggleExpand={() => setExpandedId(expandedId === envelope.id ? null : envelope.id)}
              draft={editing[envelope.id]}
              onStartEdit={() => startEdit(envelope)}
              onDraftChange={(draft) => setEditing((prev) => ({ ...prev, [envelope.id]: draft }))}
              onSaveEdit={() => saveEdit(envelope.id)}
              onChanged={onChanged}
              onTransactionsChanged={onTransactionsChanged}
              onArchive={() => archive(envelope.category_id)}
            />
          ))}
        </div>
      </div>
    ));
  }

  return (
    <div className="section">
      <div className="grid-3">
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Allocated for spend</span>
          <span className="figure">{formatCents(allocatedForSpendCents)}</span>
          <span className="detail">Everyday envelopes, not counting Bills.</span>
        </div>
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Allocated for goals</span>
          <span className="figure">{formatCents(allocatedForGoalsCents)}</span>
          <span className="detail">Savings envelopes with a target.</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Unallocated</span>
          <span className="figure">{formatCents(unallocatedCents)}</span>
          <span className="detail">This month's income, minus Bills and everything allocated above.</span>
        </div>
      </div>

      {/* Income, then Bills, then Planned spend, then Other spend — each
          collapsed to one summary row until expanded. */}
      <SummaryTab
        title="Income"
        itemCountLabel={`${incomeTransactions.length} transaction${incomeTransactions.length === 1 ? "" : "s"} this month`}
        totalCents={incomeThisMonthCents}
        isExpanded={expandedTab === "income"}
        onToggle={() => setExpandedTab((t) => (t === "income" ? null : "income"))}
        onAdd={() => setAddingTab((t) => (t === "income" ? null : "income"))}
      >
        {addingTab === "income" && (
          <RecurringTransactionPicker
            householdId={householdId}
            kind="income"
            categories={categories}
            transactions={transactions}
            onCancel={() => setAddingTab(null)}
            onDone={async () => {
              setAddingTab(null);
              await onChanged();
            }}
          />
        )}
        <div className="row-list">
          {incomeTransactions.map((t) => (
            <div className="row-item" key={t.id}>
              <div className="row-figure" style={{ flex: "1 1 auto" }}>
                <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                <span className="row-meta">{t.posted_at}</span>
              </div>
              <span className="money positive" style={{ minWidth: 96, textAlign: "right" }}>
                {formatCents(t.amount_cents)}
              </span>
            </div>
          ))}
          {incomeTransactions.length === 0 && (
            <div className="row-item">
              <span className="hint">No income this month yet.</span>
            </div>
          )}
        </div>
      </SummaryTab>

      <SummaryTab
        title="Bills"
        itemCountLabel={`${bills.length} bill${bills.length === 1 ? "" : "s"} · ${formatCents(billsCommittedCents)} budgeted/mo`}
        totalCents={billsCommittedCents}
        isExpanded={expandedTab === "bills"}
        onToggle={() => setExpandedTab((t) => (t === "bills" ? null : "bills"))}
        onAdd={() => setAddingTab((t) => (t === "bills" ? null : "bills"))}
      >
        {addingTab === "bills" && (
          <RecurringTransactionPicker
            householdId={householdId}
            kind="expense"
            categories={categories}
            transactions={transactions}
            onCancel={() => setAddingTab(null)}
            onDone={async () => {
              setAddingTab(null);
              await onChanged();
            }}
          />
        )}
        <div className="row-list">
          {bills.map((envelope) => (
            <EnvelopeRow
              key={envelope.id}
              householdId={householdId}
              envelope={envelope}
              category={categoryById.get(envelope.category_id)}
              summary={envelopeSummaries[envelope.id]}
              month={month}
              categories={categories}
              transactions={transactions}
              isExpanded={expandedId === envelope.id}
              onToggleExpand={() => setExpandedId(expandedId === envelope.id ? null : envelope.id)}
              draft={editing[envelope.id]}
              onStartEdit={() => startEdit(envelope)}
              onDraftChange={(draft) => setEditing((prev) => ({ ...prev, [envelope.id]: draft }))}
              onSaveEdit={() => saveEdit(envelope.id)}
              onChanged={onChanged}
              onTransactionsChanged={onTransactionsChanged}
              onArchive={() => archive(envelope.category_id)}
            />
          ))}
          {bills.length === 0 && (
            <div className="row-item">
              <span className="hint">No bills yet.</span>
            </div>
          )}
        </div>
      </SummaryTab>

      <SummaryTab
        title="Planned spend"
        itemCountLabel={`${plannedEnvelopes.length} envelope${plannedEnvelopes.length === 1 ? "" : "s"}`}
        totalCents={allocatedForSpendCents + allocatedForGoalsCents}
        isExpanded={expandedTab === "planned"}
        onToggle={() => setExpandedTab((t) => (t === "planned" ? null : "planned"))}
        onAdd={() => setAddingTab((t) => (t === "planned" ? null : "planned"))}
      >
        {addingTab === "planned" && (
          <RecurringTransactionPicker
            householdId={householdId}
            kind="expense"
            categories={categories}
            transactions={transactions}
            onCancel={() => setAddingTab(null)}
            onDone={async () => {
              setAddingTab(null);
              await onChanged();
            }}
          />
        )}
        {groupedPlanned.length > 0 ? renderEnvelopeGroups(groupedPlanned) : <p className="hint">Set a monthly target on an envelope to see it here.</p>}
      </SummaryTab>

      <SummaryTab
        title="Other spend"
        itemCountLabel={`${otherEnvelopes.length} envelope${otherEnvelopes.length === 1 ? "" : "s"}`}
        totalCents={otherSpendCents}
        isExpanded={expandedTab === "other"}
        onToggle={() => setExpandedTab((t) => (t === "other" ? null : "other"))}
        onAdd={() => setAddingTab((t) => (t === "other" ? null : "other"))}
      >
        {addingTab === "other" && (
          <RecurringTransactionPicker
            householdId={householdId}
            kind="expense"
            categories={categories}
            transactions={transactions}
            onCancel={() => setAddingTab(null)}
            onDone={async () => {
              setAddingTab(null);
              await onChanged();
            }}
          />
        )}
        {groupedOther.length > 0 ? renderEnvelopeGroups(groupedOther) : <p className="hint">Nothing untargeted right now.</p>}
      </SummaryTab>

      <section className="card card--padded">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Rebuild spending plan with AI</h2>
          <button type="button" className="secondary" onClick={loadSuggestions} disabled={loadingSuggestions}>
            {loadingSuggestions ? "Thinking…" : "Suggest categories"}
          </button>
        </div>
        {suggestions && (
          <div className="section" style={{ gap: 12, marginTop: 16 }}>
            {suggestions.length === 0 ? (
              <p className="hint">Nothing to suggest — your existing categories already cover your recent activity.</p>
            ) : (
              <>
                <p className="hint" style={{ margin: 0 }}>
                  Checking "Rebuild" archives every category currently on this page and replaces it with what's checked below. Bills are not affected.
                </p>
                <div className="row-list">
                  {suggestions.map((s, i) => (
                    <div className="row-item" key={`${s.name}-${i}`}>
                      <input type="checkbox" checked={suggestChecked[i] ?? true} onChange={(e) => setSuggestChecked((prev) => ({ ...prev, [i]: e.target.checked }))} />
                      <div className="row-figure" style={{ flex: "1 1 auto" }}>
                        <span className="row-title">
                          {s.name} <span className="badge badge--muted">{s.kind}</span>
                        </span>
                        <span className="row-meta">{s.reasoning}</span>
                      </div>
                      <span className="row-meta">{s.groupName}</span>
                      <span className="money">{s.monthlyTargetCents ? formatCents(s.monthlyTargetCents) : "—"}</span>
                    </div>
                  ))}
                </div>
                <div className="row">
                  <button type="button" onClick={rebuildFromSuggestions} disabled={rebuilding}>
                    {rebuilding ? "Rebuilding…" : "Rebuild spending plan"}
                  </button>
                  <button type="button" className="secondary" onClick={() => setSuggestions(null)} disabled={rebuilding}>
                    Discard
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {suggestError && <p className="error">{suggestError}</p>}
      </section>

      <section className="card card--padded">
        <h2>Add a category</h2>
        <form onSubmit={addCategory}>
          <div className="row">
            <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
            <select value={newKind} onChange={(e) => setNewKind(e.target.value as "expense" | "savings")}>
              <option value="expense">Expense</option>
              <option value="savings">Savings goal</option>
            </select>
          </div>
          <div className="row" style={{ marginTop: "0.5rem" }}>
            <input type="text" placeholder="Group (e.g. Housing)" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} style={{ width: 160 }} />
            <input
              type="text"
              inputMode="decimal"
              placeholder="Monthly target $ (optional)"
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
