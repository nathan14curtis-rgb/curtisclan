import type { AssetType } from "../api";

interface Props {
  assetType: AssetType;
}

export function MaintenancePage({ assetType }: Props) {
  return (
    <div className="section">
      <section className="card card--padded">
        <p className="hint">Maintenance tasks for {assetType === "property" ? "the house" : "the cars"} are on their way.</p>
      </section>
    </div>
  );
}
