export type Tab = "home" | "transactions" | "envelopes" | "bills" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "Home" },
  { id: "transactions", label: "Transactions" },
  { id: "envelopes", label: "Envelopes" },
  { id: "bills", label: "Bills" },
  { id: "settings", label: "Settings" },
];

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
}

export function Nav({ active, onChange }: Props) {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button key={t.id} className={active === t.id ? "active" : ""} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
