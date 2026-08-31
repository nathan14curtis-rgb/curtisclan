import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Account, type Household, type User } from "./api";
import { PeopleSection } from "./components/PeopleSection";
import { AccountsSection } from "./components/AccountsSection";
import { ImportSection } from "./components/ImportSection";

const STORAGE_KEY = "curtisclan.householdId";

export function App() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newHouseholdName, setNewHouseholdName] = useState("");

  // Shared here (not fetched independently per section) so that, e.g.,
  // adding a person in PeopleSection immediately unblocks the "link a
  // bank account" picker in AccountsSection without a page reload.
  const [users, setUsers] = useState<User[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      setLoading(false);
      return;
    }
    api
      .getHousehold(id)
      .then(setHousehold)
      .catch(() => localStorage.removeItem(STORAGE_KEY))
      .finally(() => setLoading(false));
  }, []);

  const refreshUsers = useCallback(async () => {
    if (!household) return;
    setUsers(await api.listUsers(household.id));
  }, [household]);

  const refreshAccounts = useCallback(async () => {
    if (!household) return;
    setAccounts(await api.listAccounts(household.id));
  }, [household]);

  useEffect(() => {
    refreshUsers();
    refreshAccounts();
  }, [refreshUsers, refreshAccounts]);

  async function createHousehold(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const hh = await api.createHousehold(newHouseholdName.trim());
      localStorage.setItem(STORAGE_KEY, hh.id);
      setHousehold(hh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create household");
    }
  }

  if (loading) return <p className="hint">Loading…</p>;

  if (!household) {
    return (
      <>
        <h1>Curtis Clan</h1>
        <p className="subtitle">Set up your household to get started.</p>
        <form className="card" onSubmit={createHousehold}>
          <h2>Create your household</h2>
          <div className="field">
            <label htmlFor="hh-name">Household name</label>
            <input
              id="hh-name"
              type="text"
              value={newHouseholdName}
              onChange={(e) => setNewHouseholdName(e.target.value)}
              placeholder="Curtis Clan"
              required
            />
          </div>
          <button type="submit">Create</button>
          {error && <p className="error">{error}</p>}
        </form>
      </>
    );
  }

  return (
    <>
      <h1>{household.name}</h1>
      <p className="subtitle">People, bank accounts, and importing your history.</p>
      <PeopleSection householdId={household.id} users={users} onChanged={refreshUsers} />
      <AccountsSection householdId={household.id} users={users} accounts={accounts} onChanged={refreshAccounts} />
      <ImportSection householdId={household.id} accounts={accounts} />
    </>
  );
}
