import { useMemo, useState, type FormEvent } from "react";
import { api, type Category, type CategorySuggestion, type Envelope, type EnvelopeMonthSummary, type Transaction } from "../api";
import { formatCents, currentMonth } from "../format";
import { envelopeStatus, STATUS_BADGE_CLASS } from "../envelopeStatus";

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

export function EnvelopesPage({ householdId, categories, envelopes, envelopeSummaries, transactions, onChanged, onTransactionsChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"expense" | "savings">("expense");
  const [newGroup, setNewGroup] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [editing, setEditing] = useState<Record<string, { groupName: string; target: string; targetDate: string }>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<Record<number, boolean>>({});
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // Bills live on the Recurring page now — this page ("Spending Plan") is
  // everything else, so an envelope's target doesn't get double-counted
  // between the two pages' "allocated" figures.
  const visible = useMemo(() => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() !== "bills"), [envelopes]);
  const bills = useMemo(() => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() === "bills"), [envelopes]);

  const allocatedForSpendCents = useMemo(
    () => visible.filter((e) => categoryById.get(e.category_id)?.kind === "expense").reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0),
    [visible, categoryById],
  );
  const allocatedForGoalsCents = useMemo(
    () => visible.filter((e) => categoryById.get(e.category_id)?.kind === "savings").reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0),
    [visible, categoryById],
  );
  const billsCommittedCents = useMemo(() => bills.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [bills]);
  const allocatedCents = allocatedForSpendCents + allocatedForGoalsCents;

  // What's actually available to plan with: recurring/actual income this
  // month, minus what bills already claim, minus what's already allocated
  // here — not a bank-balance figure (that lives in the sidebar's "safe to
  // spend"), just "how much of my income has nowhere assigned yet."
  const month = currentMonth();
  const incomeThisMonthCents = useMemo(
    () =>
      transactions
        .filter((t) => !t.is_transfer && !t.excluded_from_budget && t.category_id && categoryById.get(t.category_id)?.kind === "income" && t.posted_at.startsWith(month))
        .reduce((sum, t) => sum + t.amount_cents, 0),
    [transactions, categoryById, month],
  );
  const unallocatedCents = incomeThisMonthCents - billsCommittedCents - allocatedCents;

  const grouped = useMemo(() => {
    const byGroup = new Map<string, Envelope[]>();
    for (const e of visible) {
      const list = byGroup.get(e.group_name) ?? [];
      list.push(e);
      byGroup.set(e.group_name, list);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

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
    // visible already excludes Bills-grouped envelopes and archived ones —
    // its category ids are exactly "this page's" categories, the ones a
    // rebuild should replace.
    const visibleCategoryIds = new Set(visible.map((e) => e.category_id));
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

      {grouped.map(([groupName, groupEnvelopes]) => (
        <div key={groupName} className="section" style={{ gap: 12 }}>
          <p className="envelope-group-heading">{groupName}</p>
          <div className="row-list">
            {groupEnvelopes.map((envelope, i) => {
              const category = categoryById.get(envelope.category_id);
              const summary = envelopeSummaries[envelope.id];
              const draft = editing[envelope.id];
              const status = envelopeStatus(envelope, summary);
              const pct = envelope.monthly_target_cents && summary ? Math.min(100, Math.max(0, (summary.spentCents / envelope.monthly_target_cents) * 100)) : null;
              const isExpanded = expandedId === envelope.id;
              return (
                <div key={envelope.id}>
                <div
                  className="row-item"
                  style={{ ...(i ? {} : {}), cursor: "pointer" }}
                  onClick={(ev) => {
                    // Editing/archiving controls handle their own clicks —
                    // only bare row space toggles the drill-down.
                    if ((ev.target as HTMLElement).closest("button, input, select")) return;
                    setExpandedId(isExpanded ? null : envelope.id);
                  }}
                >
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{category?.name ?? "Unknown category"}</span>
                    {envelope.monthly_target_cents !== null && summary && (
                      <span className="row-meta">
                        {formatCents(summary.spentCents)} of {formatCents(envelope.monthly_target_cents)} spent
                      </span>
                    )}
                  </div>
                  <span className={STATUS_BADGE_CLASS[status]}>{status}</span>
                  {summary && <span className={`money ${summary.balanceCents < 0 ? "negative" : "positive"}`}>{formatCents(summary.balanceCents)} left</span>}
                  {pct !== null && (
                    <div style={{ width: 96, flex: "0 0 auto" }}>
                      <div className="progress-track">
                        <div className={`progress-fill ${pct >= 100 ? "over" : ""}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )}
                  {draft ? (
                    <div className="row" style={{ flex: "0 0 auto" }}>
                      <input
                        type="text"
                        placeholder="Group"
                        value={draft.groupName}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [envelope.id]: { ...draft, groupName: e.target.value } }))}
                        style={{ width: 100 }}
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="Target $"
                        value={draft.target}
                        onChange={(e) => setEditing((prev) => ({ ...prev, [envelope.id]: { ...draft, target: e.target.value } }))}
                        style={{ width: 90 }}
                      />
                      {category?.kind === "savings" && (
                        <input
                          type="date"
                          title="Goal date"
                          value={draft.targetDate}
                          onChange={(e) => setEditing((prev) => ({ ...prev, [envelope.id]: { ...draft, targetDate: e.target.value } }))}
                        />
                      )}
                      <button className="secondary" onClick={() => saveEdit(envelope.id)}>
                        Save
                      </button>
                    </div>
                  ) : (
                    <div className="row" style={{ flex: "0 0 auto" }}>
                      <button className="secondary" onClick={() => startEdit(envelope)}>
                        Edit
                      </button>
                      {category && (
                        <button className="danger" onClick={() => archive(category.id)}>
                          Archive
                        </button>
                      )}
                    </div>
                  )}
                </div>
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
            })}
          </div>
        </div>
      ))}
      {visible.length === 0 && <p className="hint">Nothing here yet — add one below.</p>}

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
