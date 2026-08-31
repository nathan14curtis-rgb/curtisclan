import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary } from "../api";
import { currentMonth, formatCents } from "../format";

interface Props {
  householdId: string;
  title: string;
  hint: string;
  categories: Category[];
  envelopes: Envelope[];
  /** When set, only envelopes whose group_name matches (case-insensitive)
   * show — this is the whole Bills page, reusing this same component
   * rather than a parallel implementation (see App.tsx). */
  filterGroup?: string;
  onChanged: () => Promise<void>;
}

const month = currentMonth();

export function EnvelopesPage({ householdId, title, hint, categories, envelopes, filterGroup, onChanged }: Props) {
  const [summaries, setSummaries] = useState<Record<string, EnvelopeMonthSummary>>({});
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"expense" | "savings">("expense");
  const [newGroup, setNewGroup] = useState(filterGroup ?? "");
  const [newTarget, setNewTarget] = useState("");
  const [editing, setEditing] = useState<Record<string, { groupName: string; target: string }>>({});

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const visible = useMemo(() => {
    const list = envelopes.filter((e) => !e.archived_at);
    if (!filterGroup) return list;
    return list.filter((e) => e.group_name.toLowerCase() === filterGroup.toLowerCase());
  }, [envelopes, filterGroup]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(visible.map((e) => api.getEnvelopeSummary(householdId, e.id, month).then((s) => [e.id, s] as const))).then((pairs) => {
      if (cancelled) return;
      setSummaries(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [householdId, visible]);

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
    setEditing((prev) => ({ ...prev, [e.id]: { groupName: e.group_name, target: e.monthly_target_cents ? (e.monthly_target_cents / 100).toString() : "" } }));
  }

  async function saveEdit(envelopeId: string) {
    const draft = editing[envelopeId];
    if (!draft) return;
    setError(null);
    try {
      await api.updateEnvelope(householdId, envelopeId, {
        groupName: draft.groupName.trim() || "Uncategorized",
        monthlyTargetCents: draft.target.trim() ? Math.round(Number(draft.target) * 100) : null,
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

  return (
    <>
      <h1>{title}</h1>
      <p className="subtitle">{hint}</p>

      {grouped.map(([groupName, groupEnvelopes]) => (
        <div key={groupName}>
          <p className="envelope-group-heading">{groupName}</p>
          {groupEnvelopes.map((envelope) => {
            const category = categoryById.get(envelope.category_id);
            const summary = summaries[envelope.id];
            const draft = editing[envelope.id];
            const pct =
              envelope.monthly_target_cents && summary ? Math.min(100, Math.max(0, (summary.spentCents / envelope.monthly_target_cents) * 100)) : null;
            return (
              <section className="card" key={envelope.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{category?.name ?? "Unknown category"}</strong>
                  {summary && (
                    <span className={`money ${summary.balanceCents < 0 ? "negative" : "positive"}`}>{formatCents(summary.balanceCents)} left</span>
                  )}
                </div>
                {envelope.monthly_target_cents !== null && summary && (
                  <>
                    <p className="hint">
                      {formatCents(summary.spentCents)} of {formatCents(envelope.monthly_target_cents)} spent this month
                    </p>
                    <div className="progress-track">
                      <div className={`progress-fill ${pct !== null && pct >= 100 ? "over" : ""}`} style={{ width: `${pct ?? 0}%` }} />
                    </div>
                  </>
                )}

                {draft ? (
                  <div className="row" style={{ marginTop: "0.75rem" }}>
                    <input
                      type="text"
                      placeholder="Group"
                      value={draft.groupName}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [envelope.id]: { ...draft, groupName: e.target.value } }))}
                      style={{ width: 120 }}
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Monthly target $"
                      value={draft.target}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [envelope.id]: { ...draft, target: e.target.value } }))}
                      style={{ width: 130 }}
                    />
                    <button className="secondary" onClick={() => saveEdit(envelope.id)}>
                      Save
                    </button>
                  </div>
                ) : (
                  <div className="row" style={{ marginTop: "0.75rem" }}>
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
              </section>
            );
          })}
        </div>
      ))}
      {visible.length === 0 && <p className="hint">Nothing here yet — add one below.</p>}

      <section className="card">
        <h2>{filterGroup ? `Add a ${filterGroup.toLowerCase().replace(/s$/, "")}` : "Add a category"}</h2>
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
    </>
  );
}
