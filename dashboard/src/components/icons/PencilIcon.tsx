interface Props {
  size?: number;
  color?: string;
}

export function PencilIcon({ size = 14, color = "currentColor" }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" />
    </svg>
  );
}
