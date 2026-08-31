import { useMemo, useState, type FormEvent } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary } from "../api";
import { formatCents } from "../format";
import { envelopeStatus, STATUS_BADGE_CLASS } from "../envelopeStatus";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  readyToAssignCents: number;
  onChanged: () => Promise<void>;
}

export function EnvelopesPage({ householdId, categories, envelopes, envelopeSummaries, readyToAssignCents, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<"expense" | "savings">("expense");
  const [newGroup, setNewGroup] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [editing, setEditing] = useState<Record<string, { groupName: string; target: string }>>({});

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const visible = useMemo(() => envelopes.filter((e) => !e.archived_at), [envelopes]);

  const allocatedCents = useMemo(() => visible.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [visible]);
  const needingAttention = useMemo(
    () => visible.filter((e) => envelopeStatus(e, envelopeSummaries[e.id]) !== "on track").length,
    [visible, envelopeSummaries],
  );

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
    <div className="section">
      <div className="grid-3">
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Allocated</span>
          <span className="figure">{formatCents(allocatedCents)}</span>
          <span className="detail">Across {visible.length} envelope{visible.length === 1 ? "" : "s"}.</span>
        </div>
        <div className="card card--padded stat-tile">
          <span className="label">Unassigned</span>
          <span className="figure">{formatCents(Math.max(0, readyToAssignCents))}</span>
          <span className="detail">Ready to assign into an envelope.</span>
        </div>
        <div className="card card--emphasis card--padded stat-tile">
          <span className="label">Needs attention</span>
          <span className="figure">{needingAttention}</span>
          <span className="detail">Tight or over budget this month.</span>
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
              return (
                <div className="row-item" key={envelope.id} style={i ? undefined : {}}>
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
              );
            })}
          </div>
        </div>
      ))}
      {visible.length === 0 && <p className="hint">Nothing here yet — add one below.</p>}

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
