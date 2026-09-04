import { useEffect, useMemo, useState } from "react";
import { api, type Category, type RecurringPattern, type SeriesOccurrence, type Transaction } from "../api";
import { formatCents } from "../format";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function daySuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
}

export function seriesScheduleLabel(p: RecurringPattern): string {
  if (p.frequency === "weekly") return p.day_of_week !== null ? `Every ${WEEKDAY_NAMES[p.day_of_week]}` : "Weekly";
  if (p.frequency === "semimonthly" && p.day_of_month_2 !== null) {
    return `Twice a month, the ${p.day_of_month}${daySuffix(p.day_of_month)} and the ${p.day_of_month_2}${daySuffix(p.day_of_month_2)}`;
  }
  return `Monthly on the ${p.day_of_month}${daySuffix(p.day_of_month)}`;
}

/**
 * "View series" (docs/SPENDING_PLAN_EDITING.md phase 6) — everything about
 * one recurring series in one place: what it's expected to be worth, which
 * category it files under, its schedule in words, this month's
 * occurrences, and the history that has actually matched it.
 *
 * The edits here are the series' own. Changing the expected amount moves
 * what's projected for occurrences that haven't been paid or overridden;
 * it never rewrites a matched occurrence (that already has a real
 * transaction behind it) or an override someone set by hand for one
 * month. Ending a series is deliberately not deleting it: the history it
 * matched stays on the plan and only future projection stops.
 */
export function SeriesDetailModal({
  householdId,
  pattern,
  categories,
  occurrences,
  transactions,
  onClose,
  onSaved,
  onEditSchedule,
}: {
  householdId: string;
  pattern: RecurringPattern;
  categories: Category[];
  occurrences: SeriesOccurrence[];
  transactions: Transaction[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onEditSchedule?: () => void;
}) {
  const expected = pattern.expected_amount_cents;
  const [amount, setAmount] = useState(expected === null ? "" : (Math.abs(expected) / 100).toFixed(2));
  const [categoryId, setCategoryId] = useState(pattern.category_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);

  const selectableCategories = useMemo(
    () => categories.filter((c) => !c.archived_at && (pattern.kind === "income" ? c.kind === "income" : c.kind !== "income" && c.kind !== "transfer")),
    [categories, pattern.kind],
  );

  const seriesOccurrences = useMemo(
    () => occurrences.filter((o) => o.pattern_id === pattern.id).sort((a, b) => a.due_date.localeCompare(b.due_date)),
    [occurrences, pattern.id],
  );

  // What this series has actually matched, newest first — the evidence
  // behind the projection, so a wrong expected amount is diagnosable
  // rather than mysterious.
  const matchedHistory = useMemo(() => {
    const byId = new Map(transactions.map((t) => [t.id, t]));
    return seriesOccurrences
      .filter((o) => o.matched_transaction_id)
      .map((o) => ({ occurrence: o, transaction: byId.get(o.matched_transaction_id!) }))
      .filter((row): row is { occurrence: SeriesOccurrence; transaction: Transaction } => Boolean(row.transaction))
      .sort((a, b) => b.transaction.posted_at.localeCompare(a.transaction.posted_at));
  }, [seriesOccurrences, transactions]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    const trimmed = amount.trim();
    const expectedAmountCents = trimmed === "" ? null : Math.round(Math.abs(Number(trimmed)) * 100);
    if (trimmed !== "" && !Number.isFinite(expectedAmountCents!)) {
      setError("Enter a valid amount, or clear it to go back to matched history");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateRecurringPattern(householdId, pattern.id, {
        expectedAmountCents,
        categoryId: categoryId || undefined,
      });
      // Only what hasn't happened yet: a matched occurrence has a real
      // transaction behind it, and an override is a deliberate one-month
      // decision. Neither is the series' to overwrite.
      if (expectedAmountCents !== null) {
        for (const occurrence of seriesOccurrences) {
          if (occurrence.status !== "upcoming" || occurrence.amount_override_cents !== null) continue;
          if (occurrence.amount_cents === expectedAmountCents) continue;
          await api.updateOccurrence(householdId, occurrence.id, { amountOverrideCents: expectedAmountCents });
        }
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      setSaving(false);
    }
  }

  async function endSeries() {
    setSaving(true);
    setError(null);
    try {
      await api.updateRecurringPattern(householdId, pattern.id, { endedAt: new Date().toISOString().slice(0, 10) });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to end the series");
      setSaving(false);
    }
  }

  async function resumeSeries() {
    setSaving(true);
    setError(null);
    try {
      await api.updateRecurringPattern(householdId, pattern.id, { endedAt: null });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume the series");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3 style={{ margin: 0 }}>{pattern.merchant_pattern}</h3>
          <button type="button" className="row-edit-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="hint" style={{ margin: 0 }}>
          {pattern.kind === "income" ? "Recurring deposit" : "Recurring charge"} · {seriesScheduleLabel(pattern)}
          {pattern.ended_at ? ` · ended ${pattern.ended_at.slice(0, 10)}` : ""}
        </p>

        <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="series-amount">Expected amount</label>
            <input
              id="series-amount"
              type="number"
              step="0.01"
              placeholder="From matched history"
              value={amount}
              disabled={saving}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
          <div className="field" style={{ margin: 0, flex: "1 1 180px" }}>
            <label htmlFor="series-category">Category</label>
            <select id="series-category" value={categoryId} disabled={saving} onChange={(e) => setCategoryId(e.target.value)}>
              {selectableCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {onEditSchedule && (
            <button type="button" className="secondary" disabled={saving} onClick={onEditSchedule}>
              Edit schedule
            </button>
          )}
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Changing the expected amount updates occurrences that haven't been paid yet. A month you've already overridden by hand,
          and anything already matched to a real transaction, stay as they are.
        </p>

        <div>
          <label>This month</label>
          <div className="row-list">
            {seriesOccurrences.map((o) => {
              const shown = o.amount_override_cents ?? o.amount_cents ?? pattern.expected_amount_cents;
              return (
                <div className="row-item" key={o.id}>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{o.due_date}</span>
                    <span className="row-meta">
                      {o.status === "matched" ? "Matched to a transaction" : o.status === "skipped" ? "Skipped" : "Upcoming"}
                      {o.amount_override_cents !== null ? " · amount set for this month" : ""}
                    </span>
                  </div>
                  <span className="money">{shown === null ? "—" : formatCents(shown)}</span>
                </div>
              );
            })}
            {seriesOccurrences.length === 0 && (
              <div className="row-item">
                <span className="hint">Nothing projected for this month.</span>
              </div>
            )}
          </div>
        </div>

        {matchedHistory.length > 0 && (
          <div>
            <label>Matched history</label>
            <div className="row-list">
              {matchedHistory.map(({ occurrence, transaction }) => (
                <div className="row-item" key={occurrence.id}>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{transaction.normalized_merchant ?? transaction.raw_description}</span>
                    <span className="row-meta">{transaction.posted_at}</span>
                  </div>
                  <span className="money">{formatCents(transaction.amount_cents)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && <p className="error" style={{ margin: 0 }}>{error}</p>}

        <div className="row" style={{ justifyContent: "space-between" }}>
          {pattern.ended_at ? (
            <button type="button" className="secondary" disabled={saving} onClick={resumeSeries}>
              Resume series
            </button>
          ) : confirmingEnd ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="hint">Stop projecting this?</span>
              <button type="button" className="danger" disabled={saving} onClick={endSeries}>
                End series
              </button>
              <button type="button" className="secondary" disabled={saving} onClick={() => setConfirmingEnd(false)}>
                Keep
              </button>
            </div>
          ) : (
            <button type="button" className="danger" disabled={saving} onClick={() => setConfirmingEnd(true)}>
              End series
            </button>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="secondary" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
