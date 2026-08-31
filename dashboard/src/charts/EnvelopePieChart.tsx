import { useState } from "react";
import { formatCents } from "../format";
import { shadeHex } from "./shadeHex";

export interface PieSliceInput {
  id: string;
  name: string;
  groupName: string;
  plannedCents: number;
  spentCents: number;
  count: number;
}

interface Props {
  slices: PieSliceInput[];
}

const CX = 160;
const CY = 160;
const R = 128;
const GROUP_BASE_COLORS = ["#cc785c", "#5db8a6", "#e8a55a"];
const SHADE_OFFSETS = [0, -0.22, 0.28];

function pt(r: number, angle: number): [number, number] {
  return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
}

/** Envelope-fill chart: a full circle represents the budget, and each
 * slice's radius (not just its angle) grows toward — and past, in red —
 * the outer guide ring to show how close to over budget it is. Slices
 * sharing a group get related shades of the same base color. Hover-only
 * detail strip below, no permanent legend, so the chart can be as large as
 * possible (per the design chat: added specifically to let it grow). */
export function EnvelopePieChart({ slices }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const plannedTotal = slices.reduce((sum, s) => sum + s.plannedCents, 0);
  if (plannedTotal <= 0) {
    return <p className="hint">Set a monthly target on an envelope to see the fill chart.</p>;
  }

  const groupBase = new Map<string, string>();
  const groupSeen = new Map<string, number>();
  let angle = -Math.PI / 2;

  const geometry = slices.map((s, i) => {
    if (!groupBase.has(s.groupName)) {
      groupBase.set(s.groupName, GROUP_BASE_COLORS[groupBase.size % GROUP_BASE_COLORS.length]!);
    }
    const base = groupBase.get(s.groupName)!;
    const seenIdx = groupSeen.get(s.groupName) ?? 0;
    groupSeen.set(s.groupName, seenIdx + 1);
    const fill = shadeHex(base, SHADE_OFFSETS[seenIdx % SHADE_OFFSETS.length]!);

    const sweep = (s.plannedCents / plannedTotal) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const ratio = s.plannedCents > 0 ? s.spentCents / s.plannedCents : 0;
    const r = Math.max(6, R * Math.min(ratio, 1.22));
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = pt(r, a0);
    const [x1, y1] = pt(r, a1);
    const [cx0, cy0] = pt(R, a0);
    const [cx1, cy1] = pt(R, a1);
    const over = ratio > 1;
    const mid = (a0 + a1) / 2;
    const hovered = hoveredIdx === i;
    const dimmed = hoveredIdx != null && !hovered;
    const pop = hovered ? 6 : 0;

    return {
      slice: s,
      fill,
      d: `M ${CX} ${CY} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`,
      capD: `M ${cx0.toFixed(1)} ${cy0.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${cx1.toFixed(1)} ${cy1.toFixed(1)}`,
      capStroke: over ? "#c64545" : "#3d3d3a",
      wrapStyle: {
        transform: `translate(${(Math.cos(mid) * pop).toFixed(1)}px, ${(Math.sin(mid) * pop).toFixed(1)}px)`,
        transition: "transform 140ms ease, opacity 140ms ease",
        opacity: dimmed ? 0.35 : 1,
        filter: hovered ? "drop-shadow(0 4px 10px rgba(20,20,19,0.25))" : "none",
      },
    };
  });

  const hovered = hoveredIdx != null ? geometry[hoveredIdx] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, flex: 1 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1 }}>
        <svg viewBox="0 0 320 320" style={{ width: "100%", maxWidth: 340, height: 320, overflow: "visible" }}>
          <circle cx={160} cy={160} r={128} fill="#e8e0d2" stroke="#c9beac" strokeWidth={1} strokeDasharray="3 4" />
          {geometry.map((g, i) => (
            <g key={g.slice.id} style={g.wrapStyle}>
              <path
                d={g.d}
                fill={g.fill}
                stroke="#efe9de"
                strokeWidth={1.5}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(null)}
              />
              <path d={g.capD} fill="none" stroke={g.capStroke} strokeWidth={1} />
            </g>
          ))}
        </svg>
      </div>
      <div style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
        {hovered ? (
          <>
            <span style={{ width: 9, height: 9, borderRadius: 2, flex: "0 0 auto", background: hovered.fill }} />
            <span style={{ fontSize: 14, fontWeight: 500, color: "#141413" }}>{hovered.slice.name}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "#6c6a64" }}>
              {Math.round((hovered.slice.spentCents / hovered.slice.plannedCents) * 100)}% of envelope
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "#141413" }}>
              {formatCents(hovered.slice.spentCents)} of {formatCents(hovered.slice.plannedCents)}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "#6c6a64" }}>{hovered.slice.count} transactions</span>
          </>
        ) : (
          <span style={{ fontSize: 13, color: "#8e8b82" }}>hover a slice for detail</span>
        )}
      </div>
    </div>
  );
}
