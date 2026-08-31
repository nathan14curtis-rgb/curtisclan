import { formatCents } from "../format";

interface Props {
  /** Cumulative spend through each elapsed day, index 0 = day 1. */
  dailyCumulativeCents: number[];
  budgetCents: number;
  daysInMonth: number;
  accentColor?: string;
}

const CHART_W = 480;
const CHART_H = 149;

/** Cumulative-spend-vs-pace line chart — the design mockup's "single line
 * from 0 to 100 that represents dollars spent that month," graphically
 * comparing actual cumulative spend to what spend should be month-to-date
 * to stay on budget. */
export function PaceChart({ dailyCumulativeCents, budgetCents, daysInMonth, accentColor = "#cc785c" }: Props) {
  const todayIdx = dailyCumulativeCents.length;
  const xAt = (day: number) => (day / daysInMonth) * CHART_W;
  const yAt = (cents: number) => CHART_H - Math.min(1, budgetCents > 0 ? cents / budgetCents : 0) * CHART_H;

  const actualPoints = dailyCumulativeCents.map((v, i) => `${xAt(i + 1).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
  const actualToday = dailyCumulativeCents[dailyCumulativeCents.length - 1] ?? 0;
  const actualArea = `0,${CHART_H} ${actualPoints} ${xAt(todayIdx).toFixed(1)},${CHART_H}`;
  const pacePoints = `0,${CHART_H} ${CHART_W},0`;
  const paceToday = (todayIdx / daysInMonth) * budgetCents;
  const overPace = actualToday > paceToday;
  const lineColor = overPace ? "#c64545" : accentColor;
  const diffCents = Math.abs(actualToday - paceToday);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H + 1}`} style={{ width: "100%", height: 150, overflow: "visible" }}>
        <line x1={0} y1={0} x2={CHART_W} y2={0} stroke="#e8e0d2" strokeWidth={1} />
        <line x1={0} y1={CHART_H / 2} x2={CHART_W} y2={CHART_H / 2} stroke="#e8e0d2" strokeWidth={1} />
        <line x1={0} y1={CHART_H} x2={CHART_W} y2={CHART_H} stroke="#c9beac" strokeWidth={1} />
        <polyline points={pacePoints} fill="none" stroke="#8e8b82" strokeWidth={1.5} strokeDasharray="5 5" />
        {dailyCumulativeCents.length > 0 && (
          <>
            <polygon points={actualArea} fill={lineColor} opacity={0.14} />
            <polyline points={actualPoints} fill="none" stroke={lineColor} strokeWidth={2.5} />
            <circle cx={xAt(todayIdx)} cy={yAt(actualToday)} r={4.5} fill={lineColor} />
          </>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 500, color: "#8e8b82" }}>
        <span>Day 1 · $0</span>
        <span style={{ fontWeight: 500, color: overPace ? "#c64545" : "#5db8a6" }}>
          {formatCents(diffCents)} {overPace ? "over pace" : "under pace"}
        </span>
        <span>
          Day {daysInMonth} · {formatCents(budgetCents)}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 13, color: "#6c6a64" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 16, height: 2, background: lineColor }} />
          actual spend
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 16, height: 0, borderTop: "2px dashed #8e8b82" }} />
          on-pace line
        </span>
      </div>
    </div>
  );
}
