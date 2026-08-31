import { useEffect, useMemo, useState } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary, type Transaction } from "../api";
import { currentMonth, formatCents } from "../format";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  transactions: Transaction[];
  onGoToTransactions: () => void;
}

const month = currentMonth();

// TODO(task: Overview + charts): replaced with the pace/pie chart redesign
// once EnvelopesPage/BillsPage/TransactionsPage land — see the plan's
// build-order note that Overview depends on both new chart components.
export function OverviewPage({ householdId, categories, envelopes, transactions, onGoToTransactions }: Props) {
  const [summaries, setSummaries] = useState<Record<string, EnvelopeMonthSummary>>({});
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const activeEnvelopes = useMemo(() => envelopes.filter((e) => !e.archived_at), [envelopes]);

  useEffect(() => {
    let cancelled = false;
    Promise.all(activeEnvelopes.map((e) => api.getEnvelopeSummary(householdId, e.id, month).then((s) => [e.id, s] as const))).then((pairs) => {
      if (cancelled) return;
      setSummaries(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [householdId, activeEnvelopes]);

  const totalRemaining = Object.values(summaries).reduce((sum, s) => sum + s.balanceCents, 0);
  const totalSpent = Object.values(summaries).reduce((sum, s) => sum + s.spentCents, 0);
  const needsReview = transactions.filter((t) => !t.category_id && !t.is_transfer);

  const byGroup = useMemo(() => {
    const groups = new Map<string, { spent: number; target: number | null }>();
    for (const envelope of activeEnvelopes) {
      const summary = summaries[envelope.id];
      if (!summary) continue;
      const g = groups.get(envelope.group_name) ?? { spent: 0, target: 0 };
      g.spent += summary.spentCents;
      g.target = envelope.monthly_target_cents === null || g.target === null ? g.target : g.target + envelope.monthly_target_cents;
      groups.set(envelope.group_name, g);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [activeEnvelopes, summaries]);

  return (
    <div className="section">
      <section className="card card--emphasis card--padded">
        <div className="stat-row">
          <div className="stat">
            <span className="label">Left across all envelopes</span>
            <span className={`value money ${totalRemaining < 0 ? "negative" : ""}`}>{formatCents(totalRemaining)}</span>
          </div>
          <div className="stat">
            <span className="label">Spent this month</span>
            <span className="value money">{formatCents(totalSpent)}</span>
          </div>
          <div className="stat">
            <span className="label">Needs review</span>
            <span className="value">{needsReview.length}</span>
          </div>
        </div>
        {needsReview.length > 0 && (
          <button className="secondary" onClick={onGoToTransactions} style={{ marginTop: "0.5rem" }}>
            Review {needsReview.length} uncategorized transaction{needsReview.length === 1 ? "" : "s"}
          </button>
        )}
      </section>

      <section className="card card--padded">
        <h2>By group</h2>
        <ul className="list">
          {byGroup.map(([groupName, g]) => (
            <li key={groupName}>
              <span>{groupName}</span>
              <span className="money">{formatCents(g.spent)}{g.target !== null ? ` / ${formatCents(g.target)}` : ""}</span>
            </li>
          ))}
          {byGroup.length === 0 && (
            <li>
              <span className="hint">No envelopes yet — add one on the Envelopes page.</span>
            </li>
          )}
        </ul>
      </section>

      <section className="card card--padded">
        <h2>Recent activity</h2>
        <ul className="list">
          {transactions.slice(0, 8).map((t) => {
            const category = t.category_id ? categoryById.get(t.category_id) : null;
            return (
              <li key={t.id}>
                <span>{t.normalized_merchant ?? t.raw_description}</span>
                <span>
                  <span className="money" style={{ marginRight: "0.5rem" }}>
                    {formatCents(t.amount_cents)}
                  </span>
                  <span className="pill">{category?.name ?? "Needs review"}</span>
                </span>
              </li>
            );
          })}
          {transactions.length === 0 && (
            <li>
              <span className="hint">Nothing imported yet.</span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
