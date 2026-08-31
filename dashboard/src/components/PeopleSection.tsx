import { useState, type FormEvent } from "react";
import { api, type User } from "../api";

interface Props {
  householdId: string;
  users: User[];
  onChanged: () => Promise<void>;
}

export function PeopleSection({ householdId, users, onChanged }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phoneDrafts, setPhoneDrafts] = useState<Record<string, string>>({});

  async function addUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createUser(householdId, { name: name.trim() });
      setName("");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add person");
    }
  }

  async function verify(userId: string) {
    const phone = phoneDrafts[userId]?.trim();
    if (!phone) return;
    setError(null);
    try {
      await api.verifyPhone(householdId, userId, phone);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed — check the number is in +1XXXXXXXXXX form");
    }
  }

  return (
    <section className="card">
      <h2>People</h2>
      <ul className="list">
        {users.map((u) => (
          <li key={u.id}>
            <span>{u.name}</span>
            {u.phone_verified_at ? (
              <span className="pill ok">{u.phone_e164}</span>
            ) : (
              <span className="row">
                <input
                  type="tel"
                  placeholder="+13035551234"
                  value={phoneDrafts[u.id] ?? ""}
                  onChange={(e) => setPhoneDrafts((d) => ({ ...d, [u.id]: e.target.value }))}
                  style={{ width: 150 }}
                />
                <button className="secondary" onClick={() => verify(u.id)}>
                  Verify
                </button>
              </span>
            )}
          </li>
        ))}
        {users.length === 0 && (
          <li>
            <span className="hint">No one added yet.</span>
          </li>
        )}
      </ul>
      <p className="hint">
        Before verifying a number, that phone must text your Sendblue number once — the free plan only allows
        messaging numbers that have already said hello.
      </p>
      <form className="row" onSubmit={addUser} style={{ marginTop: "0.75rem" }}>
        <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Add person</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
