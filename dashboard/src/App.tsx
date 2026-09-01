import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  type Account,
  type Asset,
  type AssetType,
  type Category,
  type DocumentCategory,
  type Envelope,
  type EnvelopeMonthSummary,
  type Household,
  type Transaction,
  type User,
} from "./api";
import { ASSET_SUMMARY_VIEW, Sidebar, assetIdFromView } from "./components/Sidebar";
import { LoginPage } from "./components/LoginPage";
import { OverviewPage } from "./components/OverviewPage";
import { TransactionsPage } from "./components/TransactionsPage";
import { EnvelopesPage } from "./components/EnvelopesPage";
import { BillsPage } from "./components/BillsPage";
import { GoalsPage } from "./components/GoalsPage";
import { MembersPage } from "./components/MembersPage";
import { DocumentsPage } from "./components/DocumentsPage";
import { MaintenancePage } from "./components/MaintenancePage";
import { AssetsPage } from "./components/AssetsPage";
import { SettingsPage } from "./components/SettingsPage";
import { getPageHead } from "./pageHeads";
import { currentMonth, daysLeftInMonth } from "./format";

const VIEW_STORAGE_KEY = "curtisclan.activeView";

const DOCUMENT_CATEGORY_BY_VIEW: Record<string, DocumentCategory> = {
  Insurance: "insurance",
  Warranties: "warranty",
  Identification: "identification",
  Passwords: "passwords",
};
const MAINTENANCE_ASSET_TYPE_BY_VIEW: Record<string, AssetType> = { House: "property", Car: "vehicle" };

export function App() {
  const [household, setHousehold] = useState<Household | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newHouseholdName, setNewHouseholdName] = useState("");
  const [newCreatorName, setNewCreatorName] = useState("");
  const [showCreateHousehold, setShowCreateHousehold] = useState(false);
  const [activeView, setActiveView] = useState(() => localStorage.getItem(VIEW_STORAGE_KEY) ?? "Overview");

  function changeView(view: string) {
    setActiveView(view);
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  }

  // Shared here (not fetched independently per page) so an edit on one
  // page — e.g. adding a category on Envelopes — is immediately visible
  // everywhere else (Bills, Transactions' category dropdown) without a
  // page reload, the same reasoning the People/Accounts lift already used.
  const [users, setUsers] = useState<User[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [envelopes, setEnvelopes] = useState<Envelope[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [envelopeSummaries, setEnvelopeSummaries] = useState<Record<string, EnvelopeMonthSummary>>({});

  // Household identity now comes from the session cookie (src/routes/auth.ts),
  // not a client-trusted localStorage id — a 401 here just means "not
  // logged in yet," not an error to surface.
  useEffect(() => {
    api
      .getSession()
      .then((session) => {
        setCurrentUserId(session.userId);
        return api.getHousehold(session.householdId);
      })
      .then(setHousehold)
      .catch(() => {})
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

  const refreshAssets = useCallback(async () => {
    if (!household) return;
    setAssets(await api.listAssets(household.id));
  }, [household]);

  const refreshEnvelopeSummaries = useCallback(async () => {
    if (!household) return;
    setEnvelopeSummaries(await api.getEnvelopeSummaries(household.id, currentMonth()));
  }, [household]);

  useEffect(() => {
    refreshUsers();
    refreshAccounts();
    refreshCategories();
    refreshEnvelopes();
    refreshTransactions();
    refreshAssets();
    refreshEnvelopeSummaries();
  }, [refreshUsers, refreshAccounts, refreshCategories, refreshEnvelopes, refreshTransactions, refreshAssets, refreshEnvelopeSummaries]);

  // Adding a category creates its envelope in the same request (see
  // src/routes/categories.ts) — refresh both so a new envelope shows up
  // immediately instead of only after the next unrelated envelope edit.
  const refreshCategoriesAndEnvelopes = useCallback(async () => {
    await Promise.all([refreshCategories(), refreshEnvelopes(), refreshEnvelopeSummaries()]);
  }, [refreshCategories, refreshEnvelopes, refreshEnvelopeSummaries]);

  async function createHousehold(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { household: hh, userId } = await api.createHousehold(newHouseholdName.trim(), newCreatorName.trim());
      setCurrentUserId(userId);
      setHousehold(hh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create household");
    }
  }

  async function logout() {
    await api.logout().catch(() => {});
    setHousehold(null);
    setShowCreateHousehold(false);
  }

  // Ready to Assign, corrected for outstanding credit-card balances
  // (PLAN.md §8.3.1, src/envelopes/ledger.ts's computeReadyToAssign — same
  // formula, reimplemented here rather than imported across the
  // Worker/dashboard package boundary): cash on hand across depository
  // accounts, minus what's owed on cards, minus what's already parked in
  // envelope balances.
  const readyToAssignCents = useMemo(() => {
    const activeAccounts = accounts.filter((a) => a.status === "active");
    const depositoryCents = activeAccounts
      .filter((a) => a.type === "depository_checking" || a.type === "depository_savings")
      .reduce((sum, a) => sum + (a.current_balance_cents ?? 0), 0);
    const creditCardCents = activeAccounts.filter((a) => a.type === "credit_card").reduce((sum, a) => sum + (a.current_balance_cents ?? 0), 0);
    const envelopeBalanceCents = Object.values(envelopeSummaries).reduce((sum, s) => sum + s.balanceCents, 0);
    return depositoryCents - creditCardCents - envelopeBalanceCents;
  }, [accounts, envelopeSummaries]);

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const pageHeadCtx = useMemo(() => {
    const activeEnvelopes = envelopes.filter((e) => !e.archived_at);
    let expenseSpent = 0;
    let expenseTarget = 0;
    let needingAttention = 0;
    let billsCount = 0;
    let billsCommittedCents = 0;
    let goalsCount = 0;
    for (const envelope of activeEnvelopes) {
      const summary = envelopeSummaries[envelope.id];
      const category = categoryById.get(envelope.category_id);
      if (category?.kind === "expense" && envelope.monthly_target_cents) {
        expenseSpent += summary?.spentCents ?? 0;
        expenseTarget += envelope.monthly_target_cents;
      }
      if (summary && (summary.balanceCents < 0 || (envelope.monthly_target_cents && summary.spentCents >= envelope.monthly_target_cents * 0.85))) {
        needingAttention += 1;
      }
      if (envelope.group_name.toLowerCase() === "bills") {
        billsCount += 1;
        billsCommittedCents += envelope.monthly_target_cents ?? 0;
      }
      if (category?.kind === "savings" && envelope.target_date) {
        goalsCount += 1;
      }
    }
    const assetIdInView = assetIdFromView(activeView);
    const asset = assetIdInView ? assets.find((a) => a.id === assetIdInView) : undefined;
    return {
      pctOfBudget: expenseTarget > 0 ? Math.round((expenseSpent / expenseTarget) * 100) : 0,
      uncategorizedCount: transactions.filter((t) => !t.category_id && !t.is_transfer).length,
      envelopesNeedingAttention: needingAttention,
      billsCount,
      billsCommittedCents,
      goalsCount,
      memberCount: users.length,
      assetName: asset?.name,
    };
  }, [envelopes, envelopeSummaries, categoryById, transactions, users, activeView, assets]);

  if (loading) return <p className="hint">Loading…</p>;

  if (!household) {
    if (!showCreateHousehold) {
      return <LoginPage onLoggedIn={() => window.location.reload()} onCreateHouseholdInstead={() => setShowCreateHousehold(true)} />;
    }
    return (
      <div className="auth-shell">
        <h1>Home Base</h1>
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
          <div className="field">
            <label htmlFor="hh-creator-name">Your name</label>
            <input
              id="hh-creator-name"
              type="text"
              value={newCreatorName}
              onChange={(e) => setNewCreatorName(e.target.value)}
              placeholder="Nathan"
              required
            />
          </div>
          <button type="submit">Create</button>
          {error && <p className="error">{error}</p>}
          <p className="hint">
            Already have a household?{" "}
            <a href="#" onClick={(e) => (e.preventDefault(), setShowCreateHousehold(false))}>
              Log in instead
            </a>
            .
          </p>
        </form>
      </div>
    );
  }

  const head = getPageHead(activeView, pageHeadCtx);
  const documentCategory = DOCUMENT_CATEGORY_BY_VIEW[activeView];
  const maintenanceAssetType = MAINTENANCE_ASSET_TYPE_BY_VIEW[activeView];
  const assetIdInView = assetIdFromView(activeView);

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        onChange={changeView}
        assets={assets}
        household={household}
        memberCount={users.length}
        monthStatus={{ daysLeft: daysLeftInMonth(), safeToSpendCents: Math.max(0, readyToAssignCents) }}
        onOpenSettings={() => changeView("Settings")}
        onLogout={logout}
      />

      <main className="main">
        <header className="page-header">
          <div className="page-header-text">
            <span className="page-eyebrow">
              {new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })} · {head.sectionLabel}
            </span>
            <h1 className="page-title">{head.title}</h1>
            <p className="page-sub">{head.subtitle}</p>
          </div>
          {(head.secondaryCta || head.primaryCta) && (
            <div className="page-actions">
              {head.secondaryCta && <button className="secondary">{head.secondaryCta}</button>}
              {head.primaryCta && <button>{head.primaryCta}</button>}
            </div>
          )}
        </header>

        {activeView === "Overview" && (
          <OverviewPage
            householdId={household.id}
            categories={categories}
            envelopes={envelopes}
            envelopeSummaries={envelopeSummaries}
            transactions={transactions}
            onGoToTransactions={() => changeView("Transactions")}
            onGoToEnvelopes={() => changeView("Envelopes")}
          />
        )}
        {activeView === "Transactions" && (
          <TransactionsPage
            householdId={household.id}
            currentUserId={currentUserId}
            users={users}
            accounts={accounts}
            categories={categories}
            transactions={transactions}
            onChanged={refreshTransactions}
          />
        )}
        {activeView === "Envelopes" && (
          <EnvelopesPage
            householdId={household.id}
            categories={categories}
            envelopes={envelopes}
            envelopeSummaries={envelopeSummaries}
            transactions={transactions}
            readyToAssignCents={readyToAssignCents}
            onChanged={refreshCategoriesAndEnvelopes}
            onTransactionsChanged={refreshTransactions}
          />
        )}
        {activeView === "Bills" && (
          <BillsPage
            householdId={household.id}
            categories={categories}
            envelopes={envelopes}
            envelopeSummaries={envelopeSummaries}
            transactions={transactions}
            onChanged={refreshCategoriesAndEnvelopes}
          />
        )}
        {activeView === "Goals" && (
          <GoalsPage
            householdId={household.id}
            categories={categories}
            envelopes={envelopes}
            envelopeSummaries={envelopeSummaries}
            onChanged={refreshCategoriesAndEnvelopes}
          />
        )}
        {activeView === "Members" && (
          <MembersPage householdId={household.id} users={users} accounts={accounts} transactions={transactions} onChanged={refreshUsers} />
        )}
        {documentCategory && <DocumentsPage householdId={household.id} category={documentCategory} users={users} assets={assets} />}
        {maintenanceAssetType && <MaintenancePage householdId={household.id} assetType={maintenanceAssetType} assets={assets} />}
        {(activeView === ASSET_SUMMARY_VIEW || assetIdInView) && (
          <AssetsPage householdId={household.id} assets={assets} selectedAssetId={assetIdInView ?? undefined} onChanged={refreshAssets} />
        )}
        {activeView === "Settings" && (
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
      </main>
    </div>
  );
}
