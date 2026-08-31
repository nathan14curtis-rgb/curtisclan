import { useState, type FormEvent } from "react";
import { api, type Category } from "../api";

interface Props {
  householdId: string;
  categories: Category[];
  onChanged: () => Promise<void>;
}

const KIND_LABELS: Record<Category["kind"], string> = {
  expense: "Expense",
  income: "Income",
  savings: "Savings",
  transfer: "Transfer",
};

/**
 * Expense/savings categories (the envelopes) are managed on the Envelopes
 * and Bills pages, where the balance context they need actually lives.
 * This covers the rest: renaming any category, archiving/restoring, and
 * creating income/transfer categories — which have no envelope and so
 * don't belong on those pages.
 */
export function CategoriesSection({ householdId, categories, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<Category["kind"]>("income");

  const visible = categories.filter((c) => (showArchived ? c.archived_at : !c.archived_at));

  async function rename(id: string) {
    setError(null);
    try {
      await api.renameCategory(householdId, id, editName.trim());
      setEditingId(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rename");
    }
  }

  async function toggleArchived(category: Category) {
    setError(null);
    try {
      if (category.archived_at) await api.unarchiveCategory(householdId, category.id);
      else await api.archiveCategory(householdId, category.id);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    }
  }

  async function addCategory(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createCategory(householdId, { name: newName.trim(), kind: newKind });
      setNewName("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add category");
    }
  }

  return (
    <section className="card">
      <h2>Categories</h2>
      <p className="hint">Expense and savings categories (envelopes) are managed on the Envelopes and Bills pages. Income and transfer categories are here.</p>

      <label className="row" style={{ gap: "0.35rem", marginBottom: "0.5rem" }}>
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>Show archived</span>
      </label>

      <ul className="list">
        {visible.map((c) => (
          <li key={c.id}>
            {editingId === c.id ? (
              <span className="row" style={{ flex: 1 }}>
                <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 160 }} />
                <button className="secondary" onClick={() => rename(c.id)}>
                  Save
                </button>
                <button className="secondary" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <span>
                  {c.name} <span className="pill">{KIND_LABELS[c.kind]}</span>
                </span>
                <span className="row">
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditingId(c.id);
                      setEditName(c.name);
                    }}
                  >
                    Rename
                  </button>
                  <button className={c.archived_at ? "secondary" : "danger"} onClick={() => toggleArchived(c)}>
                    {c.archived_at ? "Restore" : "Archive"}
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
        {visible.length === 0 && (
          <li>
            <span className="hint">Nothing here.</span>
          </li>
        )}
      </ul>

      <form className="row" onSubmit={addCategory} style={{ marginTop: "0.75rem" }}>
        <input type="text" placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} required style={{ flex: 1 }} />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as Category["kind"])}>
          <option value="income">Income</option>
          <option value="transfer">Transfer</option>
        </select>
        <button type="submit" className="secondary">
          Add
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
