import { useEffect, useMemo, useState } from "react";
import { api, type Category, type Envelope, type EnvelopeMonthSummary, type Transaction } from "../api";
import { formatCents } from "../format";
import { envelopeStatus, STATUS_BADGE_CLASS } from "../envelopeStatus";
import { PaceChart } from "../charts/PaceChart";
import { EnvelopePieChart, type PieSliceInput } from "../charts/EnvelopePieChart";

interface Props {
  householdId: string;
  categories: Category[];
  envelopes: Envelope[];
  envelopeSummaries: Record<string, EnvelopeMonthSummary>;
  transactions: Transaction[];
  onGoToTransactions: () => void;
}

function monthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { fromDate: iso(start), toDate: iso(end), daysInMonth: end.getDate(), dayOfMonth: now.getDate() };
}

export function OverviewPage({ householdId, categories, envelopes, envelopeSummaries, transactions, onGoToTransactions }: Props) {
  const [monthTransactions, setMonthTransactions] = useState<Transaction[]>([]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const activeEnvelopes = useMemo(() => envelopes.filter((e) => !e.archived_at), [envelopes]);

  useEffect(() => {
    let cancelled = false;
    const { fromDate, toDate } = monthRange();
    api.listTransactions(householdId, { fromDate, toDate, limit: 1000 }).then((rows) => {
      if (!cancelled) setMonthTransactions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  const expenseEnvelopes = useMemo(
    () => activeEnvelopes.filter((e) => categoryById.get(e.category_id)?.kind === "expense" && e.monthly_target_cents),
    [activeEnvelopes, categoryById],
  );
  const budgetCents = useMemo(() => expenseEnvelopes.reduce((sum, e) => sum + (e.monthly_target_cents ?? 0), 0), [expenseEnvelopes]);
  const spentCents = useMemo(
    () => expenseEnvelopes.reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [expenseEnvelopes, envelopeSummaries],
  );
  const pct = budgetCents > 0 ? Math.min(100, Math.round((spentCents / budgetCents) * 100)) : 0;

  const { daysInMonth, dayOfMonth } = monthRange();
  const dailyCumulativeCents = useMemo(() => {
    const daily = new Array(dayOfMonth).fill(0);
    for (const t of monthTransactions) {
      if (t.amount_cents >= 0 || t.is_transfer || t.excluded_from_budget) continue;
      const day = Number(t.posted_at.slice(8, 10));
      if (day >= 1 && day <= dayOfMonth) daily[day - 1] += -t.amount_cents;
    }
    let running = 0;
    return daily.map((v: number) => (running += v));
  }, [monthTransactions, dayOfMonth]);

  const incomeCents = useMemo(
    () =>
      monthTransactions
        .filter((t) => t.category_id && categoryById.get(t.category_id)?.kind === "income")
        .reduce((sum, t) => sum + t.amount_cents, 0),
    [monthTransactions, categoryById],
  );
  const fixedBillsCents = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => e.group_name.toLowerCase() === "bills")
        .reduce((sum, e) => sum + (envelopeSummaries[e.id]?.spentCents ?? 0), 0),
    [activeEnvelopes, envelopeSummaries],
  );
  const savedCents = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings")
        .reduce((sum, e) => sum + (envelopeSummaries[e.id]?.allocatedCents ?? 0), 0),
    [activeEnvelopes, categoryById, envelopeSummaries],
  );

  const pieSlices: PieSliceInput[] = useMemo(() => {
    const countByCategory = new Map<string, number>();
    for (const t of monthTransactions) {
      if (!t.category_id || t.is_transfer || t.excluded_from_budget) continue;
      countByCategory.set(t.category_id, (countByCategory.get(t.category_id) ?? 0) + 1);
    }
    return expenseEnvelopes.map((e) => ({
      id: e.id,
      name: categoryById.get(e.category_id)?.name ?? "Envelope",
      groupName: e.group_name,
      plannedCents: e.monthly_target_cents ?? 0,
      spentCents: envelopeSummaries[e.id]?.spentCents ?? 0,
      count: countByCategory.get(e.category_id) ?? 0,
    }));
  }, [expenseEnvelopes, categoryById, envelopeSummaries, monthTransactions]);

  const envelopeCards = useMemo(() => activeEnvelopes.filter((e) => e.monthly_target_cents), [activeEnvelopes]);

  const goals = useMemo(
    () =>
      activeEnvelopes
        .filter((e) => categoryById.get(e.category_id)?.kind === "savings" && e.target_date)
        .slice(0, 3),
    [activeEnvelopes, categoryById],
  );

  return (
    <>
      <section className="grid-2" style={{ gridTemplateColumns: "1.15fr 1fr", alignItems: "stretch" }}>
        <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="label">Spent so far</span>
            <span className="badge badge--soft" style={{ background: "var(--surface)" }}>
              {pct}% of budget
            </span>
          </div>
          <div className="row" style={{ alignItems: "flex-end", gap: 16 }}>
            <span style={{ fontFamily: "var(--font-display)", fontSize: 64, lineHeight: 1, letterSpacing: "-1.5px", color: "var(--ink)" }}>
              {formatCents(spentCents)}
            </span>
            <span style={{ fontSize: 16, color: "var(--muted)", paddingBottom: 8 }}>of {formatCents(budgetCents)} planned</span>
          </div>
          <PaceChart dailyCumulativeCents={dailyCumulativeCents} budgetCents={budgetCents} daysInMonth={daysInMonth} />
          <div className="grid-3" style={{ borderTop: "1px solid var(--track)", paddingTop: 24 }}>
            <div className="stat-tile">
              <span className="label">Income</span>
              <span className="figure figure--small">{formatCents(incomeCents)}</span>
            </div>
            <div className="stat-tile">
              <span className="label">Fixed bills</span>
              <span className="figure figure--small">{formatCents(fixedBillsCents)}</span>
            </div>
            <div className="stat-tile">
              <span className="label">Saved</span>
              <span className="figure figure--small" style={{ color: "var(--teal)" }}>
                {formatCents(savedCents)}
              </span>
            </div>
          </div>
        </div>

        <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="label">Envelope fill · this month</span>
          </div>
          <EnvelopePieChart slices={pieSlices} />
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h2 className="section-title">Envelopes</h2>
          <a href="#" onClick={(e) => e.preventDefault()}>
            Adjust allocations
          </a>
        </div>
        <div className="grid-4">
          {envelopeCards.map((e) => {
            const category = categoryById.get(e.category_id);
            const summary = envelopeSummaries[e.id];
            const status = envelopeStatus(e, summary);
            const used = e.monthly_target_cents && summary ? Math.min(100, Math.max(0, ((e.monthly_target_cents - summary.balanceCents) / e.monthly_target_cents) * 100)) : 0;
            return (
              <div className="card card--padded" key={e.id} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="row-title">{category?.name ?? "Envelope"}</span>
                  <span className={STATUS_BADGE_CLASS[status]}>{status}</span>
                </div>
                <span style={{ fontFamily: "var(--font-display)", fontSize: 36, letterSpacing: "-0.5px", color: "var(--ink)" }}>
                  {summary ? formatCents(summary.balanceCents) : "—"}
                </span>
                <div className="progress-track">
                  <div className={`progress-fill ${summary && summary.balanceCents < 0 ? "over" : ""}`} style={{ width: `${used}%` }} />
                </div>
                <span className="row-meta">{e.monthly_target_cents ? `left of ${formatCents(e.monthly_target_cents)}` : ""}</span>
              </div>
            );
          })}
          {envelopeCards.length === 0 && <p className="hint">No budgeted envelopes yet.</p>}
        </div>
      </section>

      <section className="grid-2" style={{ gridTemplateColumns: "1.4fr 1fr", alignItems: "start" }}>
        <div className="section">
          <h2 className="section-title">Recent activity</h2>
          <div className="row-list">
            {transactions.slice(0, 6).map((t) => {
              const category = t.category_id ? categoryById.get(t.category_id) : null;
              return (
                <div className="row-item" key={t.id}>
                  <span className="row-avatar">
                    {(t.normalized_merchant ?? t.raw_description)
                      .split(" ")
                      .slice(0, 2)
                      .map((w) => w[0])
                      .join("")}
                  </span>
                  <div className="row-figure" style={{ flex: "1 1 auto" }}>
                    <span className="row-title">{t.normalized_merchant ?? t.raw_description}</span>
                  </div>
                  <span className="badge">{category?.name ?? "Needs review"}</span>
                  <span className={`money ${t.amount_cents > 0 ? "positive" : ""}`} style={{ minWidth: 96, textAlign: "right" }}>
                    {formatCents(t.amount_cents)}
                  </span>
                </div>
              );
            })}
            {transactions.length === 0 && (
              <div className="row-item">
                <span className="hint">Nothing imported yet.</span>
              </div>
            )}
          </div>
          {transactions.some((t) => !t.category_id && !t.is_transfer) && (
            <button className="secondary" onClick={onGoToTransactions}>
              Review uncategorized transactions
            </button>
          )}
        </div>

        <div className="section" style={{ gap: 20 }}>
          <h2 className="section-title">Goals</h2>
          <div className="card card--emphasis card--padded" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {goals.map((g) => {
              const summary = envelopeSummaries[g.id];
              const have = summary?.balanceCents ?? 0;
              const target = g.monthly_target_cents ?? 0;
              const barPct = target > 0 ? Math.min(100, Math.max(0, (have / target) * 100)) : 0;
              return (
                <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="row-title">{categoryById.get(g.category_id)?.name}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--muted)" }}>
                      {formatCents(have)} / {formatCents(target)}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${barPct}%` }} />
                  </div>
                  <span className="row-meta">Target date {g.target_date}</span>
                </div>
              );
            })}
            {goals.length === 0 && <span className="hint">No savings goals yet.</span>}
          </div>
        </div>
      </section>
    </>
  );
}
