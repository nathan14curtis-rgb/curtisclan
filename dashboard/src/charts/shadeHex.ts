/** Lighten (amt > 0) or darken (amt < 0) a "#rrggbb" color by a fraction —
 * ported from the design mockup, which uses this to give envelopes sharing
 * a pie-chart group distinct-but-related shades. */
export function shadeHex(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amt > 0 ? c + (255 - c) * amt : c + c * amt);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
      .join("")
  );
}
