interface Props {
  size?: number;
  color?: string;
}

/** The "auto-verified" mark — ports the design mockup's hand-rolled inline
 * SVG exactly (rounded-rect body, antenna, two eye dots). */
export function RobotIcon({ size = 12, color = "#6c6a64" }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round">
      <rect x={2.5} y={5.5} width={11} height={8} rx={2.5} />
      <line x1={8} y1={2.5} x2={8} y2={5.5} />
      <circle cx={8} cy={2} r={1} fill={color} stroke="none" />
      <circle cx={6} cy={9} r={1} fill={color} stroke="none" />
      <circle cx={10} cy={9} r={1} fill={color} stroke="none" />
    </svg>
  );
}
