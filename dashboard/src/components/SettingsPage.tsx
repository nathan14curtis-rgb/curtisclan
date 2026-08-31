import type { Account, Category, User } from "../api";
import { PeopleSection } from "./PeopleSection";
import { AccountsSection } from "./AccountsSection";
import { CategoriesSection } from "./CategoriesSection";
import { ImportSection } from "./ImportSection";

interface Props {
  householdId: string;
  users: User[];
  accounts: Account[];
  categories: Category[];
  onUsersChanged: () => Promise<void>;
  onAccountsChanged: () => Promise<void>;
  onCategoriesChanged: () => Promise<void>;
  onTransactionsChanged: () => Promise<void>;
}

export function SettingsPage({ householdId, users, accounts, categories, onUsersChanged, onAccountsChanged, onCategoriesChanged, onTransactionsChanged }: Props) {
  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">People, accounts, categories, and importing history.</p>
      <PeopleSection householdId={householdId} users={users} onChanged={onUsersChanged} />
      <AccountsSection householdId={householdId} users={users} accounts={accounts} onChanged={onAccountsChanged} />
      <CategoriesSection householdId={householdId} categories={categories} onChanged={onCategoriesChanged} />
      <ImportSection householdId={householdId} accounts={accounts} onChanged={onTransactionsChanged} />
    </>
  );
}
