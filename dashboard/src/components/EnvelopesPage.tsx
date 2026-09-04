import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Account,
  type Category,
  type CategorySuggestion,
  type Envelope,
  type EnvelopeMonthSummary,
  type RecurringPattern,
  type RecurringPatternFrequency,
  type Transaction,
} from "../api";
import { formatCents, currentMonth } from "../format";

interface Props {
  householdId: string;
  accounts: Account[];
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  currentUserId: string | null;
  onChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
}

const DAY_SUFFIX = (day: number) => {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
};

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A write that touches recurring_pattern's frequency/day_of_month_2/
 * day_of_week columns 500s on a deployment where migrations/0008 hasn't
 * been applied yet (`npx wrangler d1 migrations apply curtisclan --remote`)
 * — surfaced as a specific, actionable message instead of a bare "Failed
 * to save", the same way the older 0006 migration gap already was for
 * the bill detector. */
function describeRecurringPatternError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 500) {
    return "The database migration for recurring schedules hasn't been applied on this deployment yet. Run `npx wrangler d1 migrations apply curtisclan --remote`.";
  }
  return err instanceof Error ? err.message : fallback;
}

function scheduleLabel(p: Pick<RecurringPattern, "frequency" | "day_of_month" | "day_of_month_2" | "day_of_week">): string {
  if (p.frequency === "weekly") return p.day_of_week !== null ? `Every ${WEEKDAY_NAMES[p.day_of_week]}` : "Weekly";
  if (p.frequency === "semimonthly" && p.day_of_month_2 !== null) {
    return `Twice a month, the ${p.day_of_month}${DAY_SUFFIX(p.day_of_month)} and ${p.day_of_month_2}${DAY_SUFFIX(p.day_of_month_2)}`;
  }
  return `Monthly on the ${p.day_of_month}${DAY_SUFFIX(p.day_of_month)}`;
}

/** Controlled draft for a recurring schedule — shared by the Bills edit
 * modal ("Frequency and date") and the manual-income "Repeats" section, so
 * the three frequency shapes (monthly/semimonthly/weekly) are defined and
 * rendered in exactly one place. */
interface ScheduleState {
  frequency: RecurringPatternFrequency;
  dayOfMonth: string;
  dayOfMonth2: string;
  dayOfWeek: string; // "0".."6"
}

function defaultSchedule(dayOfMonth?: string): ScheduleState {
  return { frequency: "monthly", dayOfMonth: dayOfMonth ?? "", dayOfMonth2: "", dayOfWeek: "" };
}

function scheduleFromPattern(p: RecurringPattern): ScheduleState {
  return {
    frequency: p.frequency,
    dayOfMonth: String(p.day_of_month),
    dayOfMonth2: p.day_of_month_2 !== null ? String(p.day_of_month_2) : "",
    dayOfWeek: p.day_of_week !== null ? String(p.day_of_week) : "",
  };
}

function scheduleIsValid(s: ScheduleState): boolean {
  if (s.frequency === "weekly") return s.dayOfWeek !== "";
  if (!s.dayOfMonth.trim()) return false;
  return s.frequency !== "semimonthly" || s.dayOfMonth2.trim() !== "";
}

function scheduleToApiInput(s: ScheduleState): { frequency: RecurringPatternFrequency; dayOfMonth?: number; dayOfMonth2?: number; dayOfWeek?: number } {
  return {
    frequency: s.frequency,
    dayOfMonth: s.frequency !== "weekly" ? Number(s.dayOfMonth) : undefined,
    dayOfMonth2: s.frequency === "semimonthly" ? Number(s.dayOfMonth2) : undefined,
    dayOfWeek: s.frequency === "weekly" ? Number(s.dayOfWeek) : undefined,
  };
}

function ScheduleFields({ value, onChange }: { value: ScheduleState; onChange: (next: ScheduleState) => void }) {
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor="sched-frequency">Frequency</label>
        <select
          id="sched-frequency"
          value={value.frequency}
          onChange={(e) => onChange({ ...value, frequency: e.target.value as RecurringPatternFrequency })}
        >
          <option value="monthly">Monthly</option>
          <option value="semimonthly">Twice a month</option>
          <option value="weekly">Weekly</option>
        </select>
      </div>
      {value.frequency === "weekly" ? (
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="sched-weekday">Day</label>
          <select id="sched-weekday" value={value.dayOfWeek} onChange={(e) => onChange({ ...value, dayOfWeek: e.target.value })}>
            <option value="" disabled>
              Choose…
            </option>
            {WEEKDAY_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="sched-day">{value.frequency === "semimonthly" ? "First day" : "Day of month"}</label>
            <input
              id="sched-day"
              type="number"
              min={1}
              max={31}
              value={value.dayOfMonth}
              onChange={(e) => onChange({ ...value, dayOfMonth: e.target.value })}
              style={{ width: 90 }}
            />
          </div>
          {value.frequency === "semimonthly" && (
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="sched-day-2">Second day</label>
              <input
                id="sched-day-2"
                type="number"
                min={1}
                max={31}
                value={value.dayOfMonth2}
                onChange={(e) => onChange({ ...value, dayOfMonth2: e.target.value })}
                style={{ width: 90 }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A real dialog, not the inline draft-row-plus-window.prompt() combo the
 * page used before: fixed to the viewport and capped to 90% of it with its
 * own scrollbar, so it can never be clipped by an ancestor's overflow or
 * run off the bottom of a short widget the way the old absolutely-
 * positioned popups did. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <button type="button" className="row-edit-btn" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** The "Suggested" review row's confirm form — pick (or create) the
 * category a detected merchant+day pattern should file under. Ported
 * unchanged from the old standalone Recurring page. */
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
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!pos) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPos(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos]);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (pos) {
      setPos(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.right - 260 });
  }

  return (
    <div style={{ flex: "0 0 auto" }} onClick={(e) => e.stopPropagation()}>
      <button type="button" className="envelope-menu-button" aria-label="Envelope actions" onClick={toggle}>
        ⋮
      </button>
      {pos && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 19 }} onClick={() => setPos(null)} />
          <div className="envelope-menu-dropdown" style={{ top: pos.top, left: pos.left }}>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="envelope-menu-item"
                disabled={a.disabled}
                style={a.danger ? { color: "var(--red)" } : undefined}
                onClick={() => {
                  setPos(null);
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
    if (kind === "expense") {
      setMonthlyTarget((Math.abs(t.amount_cents) / 100).toFixed(2));
    }
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
  addLabel = "Add",
  extraAction,
  children,
}: {
  title: string;
  itemCountLabel: string;
  totalCents: number;
  isExpanded: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  extraAction?: { label: string; onClick: () => void };
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
          {extraAction && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                extraAction.onClick();
              }}
            >
              {extraAction.label}
            </button>
          )}
          {onAdd && (
            <button
              type="button"
              className="secondary"
              onClick={(e) => {
                e.stopPropagation();
                onAdd();
              }}
            >
              {addLabel}
            </button>
          )}
        </div>
      </div>
      {isExpanded && <div className="section" style={{ gap: 12 }}>{children}</div>}
    </div>
  );
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
  onEdit,
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
  onEdit: () => void;
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
            <div className="envelope-bar">{balance > 0 && <div className="envelope-bar-rollover" style={{ width: "100%" }} />}</div>
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
            { label: "Edit", icon: "🗓", onClick: onEdit },
            { label: "Change rollover amount", icon: "⇄", onClick: changeRolloverAmount },
            { label: "Edit expense series", icon: "✎", onClick: editExpenseSeries },
            { label: "Archive", icon: "🗄", danger: true, onClick: onArchive },
          ]}
        />
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

/**
 * The envelope "Edit" action's modal — Amount (+ Group, + Goal date for a
 * savings envelope) for Planned/Other/Goals rows; for a Bills row, Amount
 * plus Link Transaction (which merchant pattern feeds it) and Frequency
 * and date. A real dialog (see Modal above), not the old inline row plus
 * window.prompt() combo, so it's never clipped by the row-list it's
 * editing.
 */
function EditEnvelopeModal({
  householdId,
  envelope,
  category,
  isBills,
  linkedPattern,
  transactions,
  onClose,
  onSaved,
}: {
  householdId: string;
  envelope: Envelope;
  category: Category | undefined;
  isBills: boolean;
  linkedPattern: RecurringPattern | undefined;
  transactions: Transaction[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [amount, setAmount] = useState(envelope.monthly_target_cents !== null ? (envelope.monthly_target_cents / 100).toFixed(2) : "");
  const [groupName, setGroupName] = useState(envelope.group_name);
  const [targetDate, setTargetDate] = useState(envelope.target_date ?? "");
  const [merchantPattern, setMerchantPattern] = useState(linkedPattern?.merchant_pattern ?? "");
  const [merchantSearch, setMerchantSearch] = useState("");
  const [schedule, setSchedule] = useState<ScheduleState>(linkedPattern ? scheduleFromPattern(linkedPattern) : defaultSchedule());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isGoal = category?.kind === "savings";

  const merchantCandidates = useMemo(() => {
    const needle = merchantSearch.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Set<string>();
    const results: Transaction[] = [];
    for (const t of transactions) {
      if (t.is_transfer || t.amount_cents >= 0) continue;
      const merchant = t.normalized_merchant ?? t.raw_description;
      if (!merchant.toLowerCase().includes(needle)) continue;
      if (seen.has(merchant)) continue;
      seen.add(merchant);
      results.push(t);
      if (results.length >= 6) break;
    }
    return results;
  }, [merchantSearch, transactions]);

  function pickMerchant(t: Transaction) {
    setMerchantPattern(t.normalized_merchant ?? t.raw_description);
    setMerchantSearch("");
    setAmount((Math.abs(t.amount_cents) / 100).toFixed(2));
    if (schedule.frequency === "monthly") {
      setSchedule((s) => ({ ...s, dayOfMonth: String(Number(t.posted_at.slice(8, 10))) }));
    }
  }

  async function save() {
    if (isBills && merchantPattern.trim() && !scheduleIsValid(schedule)) {
      setError("Fill in the frequency's date");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateEnvelope(householdId, envelope.id, {
        groupName: isBills ? envelope.group_name : groupName.trim() || "Uncategorized",
        monthlyTargetCents: amount.trim() ? Math.round(Number(amount) * 100) : null,
        targetDate: isGoal && !isBills ? targetDate || null : envelope.target_date,
      });

      if (isBills && merchantPattern.trim()) {
        const scheduleInput = scheduleToApiInput(schedule);
        if (linkedPattern) {
          await api.updateRecurringPattern(householdId, linkedPattern.id, { merchantPattern, ...scheduleInput });
        } else {
          await api.createRecurringPattern(householdId, { merchantPattern, kind: "expense", categoryId: envelope.category_id, ...scheduleInput });
        }
      }

      await onSaved();
      onClose();
    } catch (err) {
      setError(describeRecurringPatternError(err, "Failed to save"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={category?.name ?? "Edit"} onClose={onClose}>
      <div className="field">
        <label htmlFor="edit-amount">Amount ($/mo)</label>
        <input id="edit-amount" type="text" inputMode="decimal" placeholder="No target set" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>

      {!isBills && (
        <div className="field">
          <label htmlFor="edit-group">Group</label>
          <input id="edit-group" type="text" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
        </div>
      )}

      {!isBills && isGoal && (
        <div className="field">
          <label htmlFor="edit-goal-date">Goal date</label>
          <input id="edit-goal-date" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
        </div>
      )}

      {isBills && (
        <>
          <div className="field">
            <label htmlFor="edit-link-txn">Link transaction</label>
            {merchantPattern ? (
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{merchantPattern}</span>
                <button type="button" className="secondary" onClick={() => setMerchantPattern("")}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  id="edit-link-txn"
                  type="text"
                  placeholder="Search past transactions…"
                  value={merchantSearch}
                  onChange={(e) => setMerchantSearch(e.target.value)}
                />
                {merchantCandidates.length > 0 && (
                  <div className="row-list" style={{ marginTop: 8 }}>
                    {merchantCandidates.map((t) => (
                      <div className="row-item" key={t.id} style={{ cursor: "pointer" }} onClick={() => pickMerchant(t)}>
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
              </>
            )}
          </div>

          {merchantPattern && (
            <div className="field">
              <label>Frequency and date</label>
              <ScheduleFields value={schedule} onChange={setSchedule} />
            </div>
          )}
        </>
      )}

      {error && <p className="error">{error}</p>}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * "Add income" on the Income tab — a deposit recorded by hand instead of
 * waiting for it to show up from a linked account (or for a household
 * with no bank feed at all). Writes a manual transaction, and — when
 * "Repeats" is checked — a confirmed recurring pattern too, so future
 * deposits with the same description auto-match going forward.
 */
function AddIncomeModal({
  householdId,
  accounts,
  categories,
  currentUserId,
  onClose,
  onSaved,
}: {
  householdId: string;
  accounts: Account[];
  categories: Category[];
  currentUserId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const incomeCategories = useMemo(() => categories.filter((c) => !c.archived_at && c.kind === "income"), [categories]);
  const activeAccounts = useMemo(() => accounts.filter((a) => a.status !== "removed"), [accounts]);

  const [amount, setAmount] = useState("");
  const [postedAt, setPostedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [description, setDescription] = useState("");
  const [accountId, setAccountId] = useState(activeAccounts[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState(incomeCategories[0]?.id ?? "");
  const [repeats, setRepeats] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleState>(() => defaultSchedule(String(Number(new Date().toISOString().slice(8, 10)))));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setError("Enter an amount");
    if (!description.trim()) return setError("Enter a description");
    if (!accountId) return setError("Choose an account");
    if (!categoryId) return setError("Choose a category");
    if (repeats && !scheduleIsValid(schedule)) return setError("Fill in the frequency's date");

    setSaving(true);
    setError(null);
    try {
      await api.createTransaction(householdId, {
        accountId,
        postedAt,
        amountCents: cents,
        description: description.trim(),
        categoryId,
        createdByUserId: currentUserId ?? undefined,
      });
      if (repeats) {
        await api.createRecurringPattern(householdId, {
          merchantPattern: description.trim(),
          kind: "income",
          categoryId,
          ...scheduleToApiInput(schedule),
        });
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(describeRecurringPatternError(err, "Failed to add income"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add income" onClose={onClose}>
      <div className="row">
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="income-amount">Amount</label>
          <input id="income-amount" type="text" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="income-date">Date</label>
          <input id="income-date" type="date" value={postedAt} onChange={(e) => setPostedAt(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="income-description">Description</label>
        <input
          id="income-description"
          type="text"
          placeholder="e.g. Paycheck"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="row">
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="income-account">Account</label>
          <select id="income-account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {activeAccounts.length === 0 && <option value="">No accounts yet</option>}
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ margin: 0, flex: 1 }}>
          <label htmlFor="income-category">Category</label>
          <select id="income-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {incomeCategories.length === 0 && <option value="">No income categories yet</option>}
            {incomeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
        Repeats
      </label>
      {repeats && (
        <div className="field">
          <label>Frequency and date</label>
          <ScheduleFields value={schedule} onChange={setSchedule} />
        </div>
      )}

      {error && <p className="error">{error}</p>}

      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button type="button" className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Add income"}
        </button>
      </div>
    </Modal>
  );
}

export function EnvelopesPage({ householdId, accounts, categories, envelopes, envelopeSummaries, transactions, currentUserId, onChanged, onTransactionsChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editingEnvelope, setEditingEnvelope] = useState<Envelope | null>(null);
  const [addingIncome, setAddingIncome] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<"income" | "bills" | "planned" | "other" | null>(null);
  const [addingTab, setAddingTab] = useState<"income" | "bills" | "planned" | "other" | null>(null);
  const [suggestions, setSuggestions] = useState<CategorySuggestion[] | null>(null);
  const [suggestChecked, setSuggestChecked] = useState<Record<number, boolean>>({});
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [patterns, setPatterns] = useState<RecurringPattern[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const refreshPatterns = async () => {
    try {
      setPatterns(await api.listRecurringPatterns(householdId));
    } catch (err) {
      // A missing recurring_pattern table (migration 0006 not yet applied
      // on this deployment) shouldn't take the whole page down — everything
      // else still works without it, so just leave detection empty.
      console.error("Failed to load recurring patterns:", err);
    }
  };
  useEffect(() => {
    refreshPatterns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  const suggestedPatterns = useMemo(() => patterns.filter((p) => p.status === "suggested"), [patterns]);
  const confirmedPatternByCategory = useMemo(
    () => new Map(patterns.filter((p) => p.status === "confirmed" && p.category_id).map((p) => [p.category_id!, p])),
    [patterns],
  );

  async function detectPatterns() {
    setDetecting(true);
    setDetectError(null);
    try {
      await api.detectRecurringPatterns(householdId);
      await refreshPatterns();
    } catch (err) {
      setDetectError(describeRecurringPatternError(err, "Failed to look for recurring patterns"));
    } finally {
      setDetecting(false);
    }
  }

  async function confirmPattern(pattern: RecurringPattern, input: { categoryId?: string; newCategoryName?: string; kind?: "expense" | "income" }) {
    setDetectError(null);
    try {
      await api.confirmRecurringPattern(householdId, pattern.id, input);
      await Promise.all([refreshPatterns(), onChanged()]);
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : "Failed to confirm");
    }
  }

  async function dismissPattern(patternId: string) {
    setDetectError(null);
    try {
      await api.dismissRecurringPattern(householdId, patternId);
      await refreshPatterns();
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : "Failed to dismiss");
    }
  }

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
  // Not the goal's total target (monthly_target_cents on a savings
  // envelope is the finish line, not a monthly figure — see GoalsPage's
  // "of $X target") but what putting money in *this month* actually takes
  // to still land on the goal date: the shortfall spread evenly across
  // the months remaining. An envelope with no target_date has no goal
  // date to amortize against, so it falls back to treating its target as
  // the monthly figure directly.
  const allocatedForGoalsCents = useMemo(
    () =>
      plannedEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings")
        .reduce((sum, e) => {
          const target = e.monthly_target_cents ?? 0;
          if (!e.target_date) return sum + target;
          const have = envelopeSummaries[e.id]?.balanceCents ?? 0;
          const monthsRemaining = Math.max(1, Math.round((Date.parse(e.target_date) - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)));
          return sum + Math.max(0, Math.round((target - have) / monthsRemaining));
        }, 0),
    [plannedEnvelopes, categoryById, envelopeSummaries],
  );
  const billsCommittedCents = useMemo(() => bills.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [bills]);
  const allocatedCents = allocatedForSpendCents + allocatedForGoalsCents;
  const unallocatedCents = incomeThisMonthCents - billsCommittedCents - allocatedCents;
  const otherSpendCents = useMemo(
    () => otherEnvelopes.reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [otherEnvelopes, envelopeSummaries],
  );
  // Other spend has no envelopes of its own to browse — it's just
  // whatever landed in an untargeted expense category this month, so it
  // renders as a flat transaction list (like Income) rather than the
  // envelope/group cards Planned spend uses.
  const otherSpendCategoryIds = useMemo(() => new Set(otherEnvelopes.map((e) => e.category_id)), [otherEnvelopes]);
  const otherSpendTransactions = useMemo(
    () =>
      transactions
        .filter((t) => !t.is_transfer && !t.excluded_from_budget && t.posted_at.startsWith(month) && t.category_id && otherSpendCategoryIds.has(t.category_id))
        .sort((a, b) => (a.posted_at < b.posted_at ? 1 : -1)),
    [transactions, otherSpendCategoryIds, month],
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

  async function archive(categoryId: string) {
    setError(null);
    try {
      await api.archiveCategory(householdId, categoryId);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive");
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
              onEdit={() => setEditingEnvelope(envelope)}
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
          <span className="detail">What this month needs to put in to stay on track for each goal's date.</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Unallocated</span>
          <span className="figure">{formatCents(unallocatedCents)}</span>
          <span className="detail">This month's income, minus Bills and everything allocated above.</span>
        </div>
      </div>

      <section className="card card--padded">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div>
            <h2 style={{ margin: 0 }}>Find recurring bills &amp; income</h2>
            <p className="hint" style={{ margin: 0 }}>Scans your transaction history for merchants that repeat on a regular schedule.</p>
          </div>
          <button type="button" className="secondary" onClick={detectPatterns} disabled={detecting}>
            {detecting ? "Looking…" : "AI Find Bills"}
          </button>
        </div>
        {suggestedPatterns.length > 0 && (
          <div className="row-list" style={{ marginTop: 16 }}>
            {suggestedPatterns.map((p) => (
              <div className="row-item" key={p.id}>
                <div className="row-figure" style={{ flex: "1 1 auto" }}>
                  <span className="row-title">{p.merchant_pattern}</span>
                  <span className="row-meta">
                    {p.kind === "expense" ? "Charge" : "Deposit"} · {scheduleLabel(p)} · seen {p.sample_count} times
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
        )}
        {detectError && <p className="error">{detectError}</p>}
      </section>

      {/* Income, then Bills, then Planned spend, then Other spend — each
          collapsed to one summary row until expanded. */}
      <SummaryTab
        title="Income"
        itemCountLabel={`${incomeTransactions.length} transaction${incomeTransactions.length === 1 ? "" : "s"} this month`}
        totalCents={incomeThisMonthCents}
        isExpanded={expandedTab === "income"}
        onToggle={() => setExpandedTab((t) => (t === "income" ? null : "income"))}
        onAdd={() => setAddingTab((t) => (t === "income" ? null : "income"))}
        addLabel="Link recurring"
        extraAction={{ label: "Add income", onClick: () => setAddingIncome(true) }}
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
        addLabel="Link recurring"
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
              onEdit={() => setEditingEnvelope(envelope)}
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
        addLabel="Link recurring"
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
        itemCountLabel={`${otherSpendTransactions.length} transaction${otherSpendTransactions.length === 1 ? "" : "s"} this month`}
        totalCents={otherSpendCents}
        isExpanded={expandedTab === "other"}
        onToggle={() => setExpandedTab((t) => (t === "other" ? null : "other"))}
      >
        <div className="row-list">
          {otherSpendTransactions.map((t) => (
            <div className="row-item" key={t.id}>
              <div className="row-figure" style={{ flex: "1 1 auto" }}>
                <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                <span className="row-meta">
                  {t.posted_at} · {categoryById.get(t.category_id ?? "")?.name ?? "Uncategorized"}
                </span>
              </div>
              <span className="money" style={{ minWidth: 96, textAlign: "right" }}>
                {formatCents(t.amount_cents)}
              </span>
            </div>
          ))}
          {otherSpendTransactions.length === 0 && (
            <div className="row-item">
              <span className="hint">Nothing untargeted this month.</span>
            </div>
          )}
        </div>
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

      {error && <p className="error">{error}</p>}

      {editingEnvelope &&
        (() => {
          const isBills = editingEnvelope.group_name.toLowerCase() === "bills";
          return (
            <EditEnvelopeModal
              householdId={householdId}
              envelope={editingEnvelope}
              category={categoryById.get(editingEnvelope.category_id)}
              isBills={isBills}
              linkedPattern={confirmedPatternByCategory.get(editingEnvelope.category_id)}
              transactions={transactions}
              onClose={() => setEditingEnvelope(null)}
              onSaved={async () => {
                await Promise.all([onChanged(), refreshPatterns()]);
              }}
            />
          );
        })()}

      {addingIncome && (
        <AddIncomeModal
          householdId={householdId}
          accounts={accounts}
          categories={categories}
          currentUserId={currentUserId}
          onClose={() => setAddingIncome(false)}
          onSaved={async () => {
            await Promise.all([onChanged(), onTransactionsChanged(), refreshPatterns()]);
          }}
        />
      )}
    </div>
  );
}
