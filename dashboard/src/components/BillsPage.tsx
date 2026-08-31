import { useMemo, useState, type FormEvent } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary } from "../api";
import { formatCents } from "../format";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
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

export function BillsPage({ householdId, categories, envelopes, envelopeSummaries, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newTarget, setNewTarget] = useState("");

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const bills = useMemo(
    () => envelopes.filter((e) => !e.archived_at && e.group_name.toLowerCase() === "bills"),
    [envelopes],
  );
  const committedCents = useMemo(() => bills.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [bills]);

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

  return (
    <div className="section">
      <div className="card card--emphasis card--padded stat-tile" style={{ maxWidth: 320 }}>
        <span className="label">Committed this month</span>
        <span className="figure">{formatCents(committedCents)}</span>
        <span className="detail">
          {bills.length} recurring bill{bills.length === 1 ? "" : "s"}.
        </span>
      </div>

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
            <span className="hint">No bills yet — group an envelope into "Bills" from Envelopes, or add one below.</span>
          </div>
        )}
      </div>

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
