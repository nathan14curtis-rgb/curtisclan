import { useEffect, useState, type FormEvent } from "react";
import { api, type Account, type User } from "../api";

declare global {
  interface Window {
    Plaid?: {
      create: (config: PlaidLinkConfig) => { open: () => void };
    };
  }
}

interface PlaidLinkConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
  onExit?: (error: unknown) => void;
}

const PLAID_LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Plaid Link")));
      return;
    }
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Plaid Link"));
    document.head.appendChild(script);
  });
}

function statusLabel(status: Account["status"]): { text: string; className: string } {
  if (status === "active") return { text: "connected", className: "pill ok" };
  if (status === "login_required") return { text: "needs re-link", className: "pill warn" };
  return { text: status, className: "pill" };
}

const ACCOUNT_TYPE_LABELS: Record<Account["type"], string> = {
  depository_checking: "Checking",
  depository_savings: "Savings",
  credit_card: "Credit card",
  other: "Other",
};

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  onChanged: () => Promise<void>;
}

/**
 * Plaid Link (PLAN.md §4.1) needs a real browser — this is why account
 * linking lives in the dashboard rather than something scriptable via
 * curl. After a successful link, the linked account rows don't exist yet
 * (they're created by the async plaid_sync queue job, see
 * src/plaid/sync.ts), so this briefly polls for them to appear.
 */
export function AccountsSection({ householdId, users, accounts, onChanged }: Props) {
  const [linkingAsUserId, setLinkingAsUserId] = useState("");
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualName, setManualName] = useState("");
  const [manualType, setManualType] = useState<Account["type"]>("depository_checking");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOwnerId, setEditOwnerId] = useState("");

  function startEdit(a: Account) {
    setEditingId(a.id);
    setEditName(a.name);
    setEditOwnerId(a.owner_user_id ?? "");
  }

  async function saveEdit(accountId: string) {
    setError(null);
    try {
      await api.updateAccount(householdId, accountId, { name: editName.trim(), ownerUserId: editOwnerId || null });
      setEditingId(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update account");
    }
  }

  async function remove(accountId: string) {
    setError(null);
    try {
      await api.updateAccount(householdId, accountId, { status: "removed" });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove account");
    }
  }

  useEffect(() => {
    setLinkingAsUserId((prev) => (prev && users.some((u) => u.id === prev) ? prev : users[0]?.id ?? ""));
  }, [users]);

  async function link() {
    if (!linkingAsUserId) return;
    setError(null);
    setLinking(true);
    try {
      await loadPlaidScript();
      const { link_token } = await api.createLinkToken(householdId, linkingAsUserId);
      window
        .Plaid!.create({
          token: link_token,
          onSuccess: (publicToken, metadata) => {
            void (async () => {
              try {
                await api.exchangePlaidToken(householdId, publicToken, metadata.institution?.name ?? undefined);
                for (let i = 0; i < 6; i++) {
                  await new Promise((resolve) => setTimeout(resolve, 2000));
                  await onChanged();
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to finish linking");
              } finally {
                setLinking(false);
              }
            })();
          },
          onExit: () => setLinking(false),
        })
        .open();
    } catch (err) {
      setLinking(false);
      setError(err instanceof Error ? err.message : "Failed to start Plaid Link");
    }
  }

  async function addManualAccount(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createAccount(householdId, {
        name: manualName.trim(),
        type: manualType,
        ownerUserId: linkingAsUserId || undefined,
      });
      setManualName("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add account");
    }
  }

  return (
    <section className="card">
      <h2>Bank accounts</h2>
      <ul className="list">
        {accounts
          .filter((a) => a.status !== "removed")
          .map((a) => {
            const status = statusLabel(a.status);
            const owner = users.find((u) => u.id === a.owner_user_id);
            if (editingId === a.id) {
              return (
                <li key={a.id} style={{ flexWrap: "wrap", gap: "0.5rem" }}>
                  <span className="row" style={{ flex: 1 }}>
                    <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: 160 }} />
                    <select value={editOwnerId} onChange={(e) => setEditOwnerId(e.target.value)}>
                      <option value="">Joint / no owner</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </span>
                  <span className="row">
                    <button className="secondary" onClick={() => saveEdit(a.id)}>
                      Save
                    </button>
                    <button className="secondary" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </span>
                </li>
              );
            }
            return (
              <li key={a.id}>
                <span>
                  {a.name}
                  {a.mask ? ` ····${a.mask}` : ""}
                  {owner && <span className="hint"> — {owner.name}</span>}
                </span>
                <span className="row">
                  <span className={status.className}>{status.text}</span>
                  <button className="secondary" onClick={() => startEdit(a)}>
                    Edit
                  </button>
                  {!a.plaid_item_id && (
                    <button className="danger" onClick={() => remove(a.id)}>
                      Remove
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        {accounts.filter((a) => a.status !== "removed").length === 0 && (
          <li>
            <span className="hint">No accounts yet.</span>
          </li>
        )}
      </ul>

      <div className="row" style={{ marginTop: "1rem" }}>
        <select value={linkingAsUserId} onChange={(e) => setLinkingAsUserId(e.target.value)}>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <button onClick={link} disabled={linking || users.length === 0}>
          {linking ? "Linking…" : "Link a bank account"}
        </button>
      </div>
      {users.length === 0 && <p className="hint">Add a person above first.</p>}

      <details style={{ marginTop: "1rem" }}>
        <summary>Or add an account manually (for CSV-only history)</summary>
        <form className="row" onSubmit={addManualAccount}>
          <input
            type="text"
            placeholder="Account name"
            value={manualName}
            onChange={(e) => setManualName(e.target.value)}
            required
          />
          <select value={manualType} onChange={(e) => setManualType(e.target.value as Account["type"])}>
            {(Object.keys(ACCOUNT_TYPE_LABELS) as Account["type"][]).map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <button type="submit" className="secondary">
            Add
          </button>
        </form>
      </details>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
