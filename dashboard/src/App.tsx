import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Account, type Category, type Envelope, type Household, type Transaction, type User } from "./api";
import { Nav, type Tab } from "./components/Nav";
import { HomePage } from "./components/HomePage";
import { TransactionsPage } from "./components/TransactionsPage";
import { EnvelopesPage } from "./components/EnvelopesPage";
import { SettingsPage } from "./components/SettingsPage";

const STORAGE_KEY = "curtisclan.householdId";

export function App() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newHouseholdName, setNewHouseholdName] = useState("");
  const [tab, setTab] = useState<Tab>("home");

  // Shared here (not fetched independently per page) so an edit on one
  // page — e.g. adding a category on Envelopes — is immediately visible
  // everywhere else (Bills, Transactions' category dropdown) without a
  // page reload, the same reasoning the People/Accounts lift already used.
  const [users, setUsers] = useState<User[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);

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

  const refreshCategories = useCallback(async () => {
    if (!household) return;
    setCategories(await api.listCategories(household.id));
  }, [household]);

  const refreshEnvelopes = useCallback(async () => {
    if (!household) return;
    setEnvelopes(await api.listEnvelopes(household.id));
  }, [household]);

  const refreshTransactions = useCallback(async () => {
    if (!household) return;
    setTransactions(await api.listTransactions(household.id, { limit: 200 }));
  }, [household]);

  useEffect(() => {
    refreshUsers();
    refreshAccounts();
    refreshCategories();
    refreshEnvelopes();
    refreshTransactions();
  }, [refreshUsers, refreshAccounts, refreshCategories, refreshEnvelopes, refreshTransactions]);

  // Adding a category creates its envelope in the same request (see
  // src/routes/categories.ts) — refresh both so a new envelope shows up
  // immediately instead of only after the next unrelated envelope edit.
  const refreshCategoriesAndEnvelopes = useCallback(async () => {
    await Promise.all([refreshCategories(), refreshEnvelopes()]);
  }, [refreshCategories, refreshEnvelopes]);

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
      <Nav active={tab} onChange={setTab} />
      {tab === "home" && (
        <HomePage
          householdId={household.id}
          categories={categories}
          envelopes={envelopes}
          transactions={transactions}
          onGoToTransactions={() => setTab("transactions")}
        />
      )}
      {tab === "transactions" && (
        <TransactionsPage
          householdId={household.id}
          accounts={accounts}
          categories={categories}
          transactions={transactions}
          onChanged={refreshTransactions}
        />
      )}
      {tab === "envelopes" && (
        <EnvelopesPage
          householdId={household.id}
          title="Envelopes"
          hint="Every expense and savings category is an envelope — what it's called here is what the text loop calls it too."
          categories={categories}
          envelopes={envelopes}
          onChanged={refreshCategoriesAndEnvelopes}
        />
      )}
      {tab === "bills" && (
        <EnvelopesPage
          householdId={household.id}
          title="Bills"
          hint={'Envelopes grouped "Bills" — recurring obligations, at a glance. Add one below, or regroup an existing envelope into "Bills" from the Envelopes page.'}
          categories={categories}
          envelopes={envelopes}
          filterGroup="Bills"
          onChanged={refreshCategoriesAndEnvelopes}
        />
      )}
      {tab === "settings" && (
        <SettingsPage
          householdId={household.id}
          users={users}
          accounts={accounts}
          categories={categories}
          onUsersChanged={refreshUsers}
          onAccountsChanged={refreshAccounts}
          onCategoriesChanged={refreshCategoriesAndEnvelopes}
          onTransactionsChanged={refreshTransactions}
        />
      )}
    </>
  );
}
