/**
 * Per-view header copy — eyebrow section label, title, subtitle, and the
 * two header CTA labels — driven by real data instead of the design
 * mockup's hardcoded `heads` lookup table. See docs plan §6/§7: some CTAs
 * are wired to a real action, others stay inert placeholders (no backend
 * concept exists yet) — getPageHead only supplies the label; App.tsx and
 * each page component decide what a click actually does.
 */

export interface PageHeadContext {
  pctOfBudget: number; // 0-100, spent/planned across funded envelopes this month
  uncategorizedCount: number;
  envelopesNeedingAttention: number; // over or within $50 of their target
  billsCount: number;
  billsCommittedCents: number;
  goalsCount: number;
  memberCount: number;
  assetName?: string; // set only when viewing a specific asset leaf
}

export interface PageHead {
  sectionLabel: string;
  title: string;
  subtitle: string;
  secondaryCta: string;
  primaryCta: string;
}

const money = (cents: number) => "$" + Math.round(cents / 100).toLocaleString("en-US");

const DOCUMENT_VIEWS = new Set(["Insurance", "Warranties", "Identification", "Passwords"]);
const MAINTENANCE_VIEWS = new Set(["House", "Car"]);

export function getPageHead(view: string, ctx: PageHeadContext): PageHead {
  switch (view) {
    case "Overview":
      return {
        sectionLabel: "Overview",
        title: "Overview",
        subtitle: `The household is tracking ${ctx.pctOfBudget > 75 ? "a little hot" : "under plan"} this month.`,
        secondaryCta: "Add expense",
        primaryCta: "Close the month",
      };
    case "Transactions":
      return {
        sectionLabel: "Transactions",
        title: "Transactions",
        subtitle:
          ctx.uncategorizedCount > 0
            ? `${ctx.uncategorizedCount} transaction${ctx.uncategorizedCount === 1 ? "" : "s"} still need${ctx.uncategorizedCount === 1 ? "s" : ""} a category.`
            : "Every dollar has a home.",
        secondaryCta: "Export CSV",
        primaryCta: "Add expense",
      };
    case "Envelopes":
      return {
        sectionLabel: "Spending Plan",
        title: "Spending Plan",
        subtitle:
          ctx.envelopesNeedingAttention > 0
            ? `${ctx.envelopesNeedingAttention} need${ctx.envelopesNeedingAttention === 1 ? "s" : ""} a nudge before the month closes.`
            : "Every envelope is on track.",
        secondaryCta: "Import last month",
        primaryCta: "New envelope",
      };
    case "Bills":
      return {
        sectionLabel: "Recurring",
        title: "Recurring",
        subtitle: `${ctx.billsCount} recurring item${ctx.billsCount === 1 ? "" : "s"}, ${money(ctx.billsCommittedCents)} committed this month.`,
        secondaryCta: "",
        primaryCta: "Add a bill",
      };
    case "Goals":
      return {
        sectionLabel: "Goals",
        title: "Goals",
        subtitle: `${ctx.goalsCount} thing${ctx.goalsCount === 1 ? "" : "s"} you're saving toward.`,
        secondaryCta: "History",
        primaryCta: "New goal",
      };
    case "Members":
      return {
        sectionLabel: "Members",
        title: "Members",
        subtitle: `${ctx.memberCount} people, shared ledger.`,
        secondaryCta: "Permissions",
        primaryCta: "Invite member",
      };
    case "Summary":
      return {
        sectionLabel: "Assets · Summary",
        title: "Assets · Summary",
        subtitle: "Financial, document, and maintenance history merged per asset.",
        secondaryCta: "Export report",
        primaryCta: "Add asset",
      };
    case "Settings":
      return {
        sectionLabel: "Settings",
        title: "Settings",
        subtitle: "People, accounts, categories, and importing history.",
        secondaryCta: "",
        primaryCta: "",
      };
  }

  if (DOCUMENT_VIEWS.has(view)) {
    return {
      sectionLabel: `Documents · ${view}`,
      title: `Documents · ${view}`,
      subtitle: "Every document, in one place.",
      secondaryCta: "Share access",
      primaryCta: "Upload document",
    };
  }

  if (MAINTENANCE_VIEWS.has(view)) {
    return {
      sectionLabel: `Maintenance · ${view}`,
      title: `Maintenance · ${view}`,
      subtitle: view === "House" ? "What the house needs." : "Keep every car road-ready.",
      secondaryCta: "Maintenance log",
      primaryCta: "Add task",
    };
  }

  // Anything else is a specific asset name — the Assets group's dynamic leaves.
  return {
    sectionLabel: "Assets",
    title: ctx.assetName ?? view,
    subtitle: "Financial, document, and maintenance history for this asset.",
    secondaryCta: "Export report",
    primaryCta: "Edit asset",
  };
}
