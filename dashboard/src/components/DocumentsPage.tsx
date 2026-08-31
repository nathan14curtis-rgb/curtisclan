import type { DocumentCategory } from "../api";

interface Props {
  category: DocumentCategory;
}

export function DocumentsPage({ category }: Props) {
  return (
    <div className="section">
      <section className="card card--padded">
        <p className="hint">The {category} document list is on its way.</p>
      </section>
    </div>
  );
}
