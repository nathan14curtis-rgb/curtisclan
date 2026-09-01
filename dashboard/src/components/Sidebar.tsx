import { useState } from "react";
import type { Asset, Household } from "../api";
import { formatCents } from "../format";

export const BUDGETING_VIEWS = ["Overview", "Transactions", "Envelopes", "Bills", "Goals", "Members"] as const;
// Internal view ids (above) stay the same — they're the persisted
// localStorage value and App.tsx's routing key — only the label shown in
// the nav changes per the rename: Envelopes -> Spending Plan, Bills ->
// Recurring (it now covers income too, not just expense bills).
const BUDGETING_LABELS: Record<(typeof BUDGETING_VIEWS)[number], string> = {
  Overview: "Overview",
  Transactions: "Transactions",
  Envelopes: "Spending Plan",
  Bills: "Recurring",
  Goals: "Goals",
  Members: "Members",
};
export const DOCUMENTS_VIEWS = ["Insurance", "Warranties", "Identification", "Passwords"] as const;
export const MAINTENANCE_VIEWS = ["House", "Car"] as const;
export const ASSET_SUMMARY_VIEW = "Summary";

export function assetView(assetId: string): string {
  return `asset:${assetId}`;
}
export function assetIdFromView(view: string): string | null {
  return view.startsWith("asset:") ? view.slice("asset:".length) : null;
}

interface Props {
  activeView: string;
  onChange: (view: string) => void;
  assets: Asset[];
  monthStatus: { daysLeft: number; safeToSpendCents: number };
  household: Household;
  memberCount: number;
  onOpenSettings: () => void;
  onLogout: () => void;
}

function NavGroup({
  label,
  isOpen,
  onToggle,
  items,
  activeView,
  onChange,
}: {
  label: string;
  isOpen: boolean;
  onToggle: () => void;
  items: Array<{ view: string; label: string }>;
  activeView: string;
  onChange: (view: string) => void;
}) {
  return (
    <div className="nav-group">
      <button className="nav-group-header" onClick={onToggle} type="button">
        <span className={`nav-caret ${isOpen ? "is-open" : ""}`}>&rsaquo;</span>
        <span>{label}</span>
      </button>
      {isOpen &&
        items.map((item) => (
          <button
            key={item.view}
            className={`nav-row ${activeView === item.view ? "is-active" : ""}`}
            onClick={() => onChange(item.view)}
            type="button"
          >
            <span className="nav-dot" />
            <span>{item.label}</span>
          </button>
        ))}
    </div>
  );
}

export function Sidebar({ activeView, onChange, assets, monthStatus, household, memberCount, onOpenSettings, onLogout }: Props) {
  const [budgetingOpen, setBudgetingOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);

  const assetItems = [
    { view: ASSET_SUMMARY_VIEW, label: "Summary" },
    ...assets.map((a) => ({ view: assetView(a.id), label: a.name })),
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-dot" />
        <span className="sidebar-brand-name">Home Base</span>
      </div>

      <nav className="nav">
        <NavGroup
          label="Budgeting"
          isOpen={budgetingOpen}
          onToggle={() => setBudgetingOpen((v) => !v)}
          items={BUDGETING_VIEWS.map((v) => ({ view: v, label: BUDGETING_LABELS[v] }))}
          activeView={activeView}
          onChange={onChange}
        />
        <NavGroup
          label="Documents"
          isOpen={documentsOpen}
          onToggle={() => setDocumentsOpen((v) => !v)}
          items={DOCUMENTS_VIEWS.map((v) => ({ view: v, label: v }))}
          activeView={activeView}
          onChange={onChange}
        />
        <NavGroup
          label="Maintenance"
          isOpen={maintenanceOpen}
          onToggle={() => setMaintenanceOpen((v) => !v)}
          items={MAINTENANCE_VIEWS.map((v) => ({ view: v, label: v }))}
          activeView={activeView}
          onChange={onChange}
        />
        <NavGroup label="Assets" isOpen={assetsOpen} onToggle={() => setAssetsOpen((v) => !v)} items={assetItems} activeView={activeView} onChange={onChange} />
      </nav>

      <div className="month-status">
        <span className="month-status-label">Month status</span>
        <span className="month-status-figure">
          {monthStatus.daysLeft} day{monthStatus.daysLeft === 1 ? "" : "s"} left
        </span>
        <span className="month-status-detail">
          You have {formatCents(monthStatus.safeToSpendCents)} safe to spend before the 1st.
        </span>
      </div>

      <button className="household-footer" onClick={onOpenSettings} type="button">
        <span className="household-avatar">
          {household.name
            .split(" ")
            .slice(0, 2)
            .map((w) => w[0])
            .join("")}
        </span>
        <span className="household-identity">
          <span className="household-name">{household.name}</span>
          <span className="household-meta">{memberCount} member{memberCount === 1 ? "" : "s"}</span>
        </span>
      </button>
      <button
        className="secondary"
        type="button"
        onClick={onLogout}
        style={{ margin: "8px 12px 0", fontSize: 13, padding: "6px 10px" }}
      >
        Log out
      </button>
    </aside>
  );
}
