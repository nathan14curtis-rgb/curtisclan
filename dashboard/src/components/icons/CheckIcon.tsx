interface Props {
  size?: number;
  color?: string;
}

export function CheckIcon({ size = 14, color = "currentColor" }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
