interface Props {
  selectedAssetId?: string;
}

export function AssetsPage({ selectedAssetId }: Props) {
  return (
    <div className="section">
      <section className="card card--padded">
        <p className="hint">{selectedAssetId ? "This asset's detail view is" : "The assets summary is"} on its way.</p>
      </section>
    </div>
  );
}
