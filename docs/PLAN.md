# Curtis Clan — AI Budgeting App

A plan to replace Quicken Simplifi with a self-owned, AI-categorized budgeting app.

> **Status:** planning only. No code has been written yet. Sections marked
> **[ASSUMED]** are my recommendation standing in for an unanswered question —
> see [Open Questions](#14-open-questions) before building on them.

---

## 1. What we're actually replacing

Simplifi does four things you rely on: it links accounts, categorizes transactions,
enforces monthly category budgets, and shows you a dashboard. Rebuilding that is
maybe 70% of the work and gains you nothing on its own.

The 30% that justifies the project:

| | Simplifi | This app |
|---|---|---|
| Categorization | Rigid merchant→category lookup, wrong on anything unusual | LLM reads full transaction context, learns from your corrections |
| Uncertainty | Silently guesses, you find it later | Asks the right spouse, on their phone, same day |
| Rules | Limited condition grammar | Arbitrary conditions, retroactive application, AI-suggested rules |
| Ownership | Your data on their terms, $x/mo forever | Your database, your model choice |

**Honest framing:** this will not save you money. Aggregator + hosting + AI API will
likely land near or above a Simplifi subscription (see §12), and it costs you real
build time. The return is control, the ambiguity-resolution loop, and categorization
that actually improves. Worth doing for those reasons; not worth doing to save $6/mo.

---

## 2. Decisions locked so far

| Decision | Choice | Source |
|---|---|---|
| Foundation | Build from scratch | Your answer |
| Hosting | Cloud, multi-tenant-ready | Your answer |
| Notification channel | Chat bot, not SMS | Your answer |
| Chat platform | **Telegram** **[ASSUMED]** | See §7.1 |
| Aggregator | **Plaid** **[ASSUMED]** | See §5.1 |
| Budget model | **Monthly caps, envelope-capable ledger** **[ASSUMED]** | See §9 |

### Why Telegram over WhatsApp

You said "WhatsApp or Telegram." They are not equivalent for this use case:

- **Telegram:** free Bot API, no business verification, **inline keyboard buttons** so
  the answer is one tap instead of typed text, trivial webhook handling. One real
  constraint: a bot cannot message a user who has never messaged it first — you and
  your wife each `/start` the bot once during setup.
- **WhatsApp:** requires Meta Business verification, and any message your app initiates
  outside a 24-hour reply window must be a **pre-approved template** — which is exactly
  what an "unsure about this charge" prompt is. Weeks of approval friction, per-message
  fees, and templates fight against dynamic content.

Telegram, with the notifier built channel-agnostic so WhatsApp can be added if
Telegram adoption at home fails.

### Why SMS was dropped

Your original ask said "send a text." US application-to-person SMS requires **A2P 10DLC**
brand and campaign registration or carriers filter it into oblivion. That's a 1–2 week
setup with fees, for a worse UX than a chat bot with tappable buttons. Telegram is
strictly better here. Flagging in case SMS was a hard requirement for a reason not
stated — if so, Twilio is still viable and the notifier interface accommodates it.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Aggregator (Plaid)                                          │
│  Link → item tokens → /transactions/sync + webhooks          │
└────────────────────────┬─────────────────────────────────────┘
                         │ new + modified + removed txns
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Ingest worker                                               │
│  dedupe · normalize merchant · detect transfers/refunds      │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Categorization cascade  (§6)                                │
│  1 user rules → 2 merchant memory → 3 LLM → 4 uncertain      │
└──────────┬──────────────────────────────┬────────────────────┘
    high confidence                  low confidence
           │                              ▼
           │              ┌──────────────────────────────────┐
           │              │  Clarification service (§7)       │
           │              │  route by card owner → Telegram   │
           │              │  buttons + memo → write back      │
           │              └──────────────┬───────────────────┘
           ▼                             │
┌─────────────────────────────────────────────────────────────┐
│  Postgres — transactions, categories, budgets, goals, rules  │
└────────────────────────┬─────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  Next.js dashboard — MTD spend, budgets, rules, review queue │
└─────────────────────────────────────────────────────────────┘
```

**Stack** **[ASSUMED]**

- **Next.js (App Router) + TypeScript** — one deployable for UI, API routes, and webhooks
- **Postgres** (Neon or Supabase) — relational, and money data is deeply relational
- **Drizzle or Prisma** for schema + migrations
- **Inngest** (or Postgres-backed queue) for the async pipeline — categorization must not
  run inside a webhook request; Plaid retries on timeout and you'll double-process
- **Claude API** — Haiku 4.5 for bulk classification, Sonnet 5 for escalation
- **Auth.js** with household scoping from day one, since "maybe others later"

Deploy on Vercel + Neon, or Fly.io if you want the workers and web in one box.

---

## 4. Data model

Described as entities, not schema code, per "no code yet."

**Core**

- `household` — the tenant boundary. Every query filters on it. Cheap now, brutal to retrofit.
- `user` — belongs to household; holds `telegram_chat_id`, notification prefs, timezone
- `account` — one per linked card/bank account. Critical field: **`owner_user_id`** — this
  is what routes the clarification to the right spouse. Also `aggregator_item_id`,
  `mask` (last 4), `type` (depository/credit), `is_active`
- `transaction` — the ledger. `account_id`, `posted_at`, `amount` (integer cents, signed),
  `raw_description`, `normalized_merchant`, `category_id`, `memo`, `pending`,
  `aggregator_txn_id` (unique — your idempotency key), `is_transfer`, `split_parent_id`
- `transaction_classification` — **kept separate from `transaction` on purpose.** Records
  `method` (rule/memory/llm/human), `confidence`, `model`, `reasoning`, `alternatives`,
  `prompt_version`. This is your audit trail and your eval set. Without it you cannot
  answer "did categorization get better after I changed the prompt?"

**Budgeting**

- `category` — hierarchical (`parent_id`), with `kind` ∈ {expense, income, savings, transfer}.
  The `kind` split is what makes income vs expense vs savings sorting fall out of the
  data model instead of being hardcoded in queries.
- `budget_period` — one row per household per month; snapshots caps so editing this
  month's budget doesn't rewrite history
- `budget_line` — `budget_period_id`, `category_id`, `limit_cents`, `rollover_cents`
  (unused until envelope mode, but present so it isn't a migration later)
- `savings_goal` — `name`, `target_cents`, `target_date`, `funded_cents`,
  `linked_account_id`, `contribution_category_id`

**Intelligence**

- `rule` — `priority`, `conditions` (JSON predicate tree), `actions`, `enabled`,
  `source` (user/ai_suggested), `match_count`
- `merchant_memory` — `household_id`, `normalized_merchant`, `category_id`, `hit_count`,
  `last_confirmed_at`. The cheap fast path that keeps LLM cost near zero.
- `clarification` — `transaction_id`, `sent_to_user_id`, `channel`, `sent_at`,
  `responded_at`, `response`, `status`. Needed for retries, timeouts, and not
  double-pinging.

**Non-obvious modeling calls**

- **Amounts as integer cents, never floats.** Non-negotiable.
- **Transfers are not expenses.** A card payment from checking is one movement, not
  income + expense. Detect by matching opposite-signed amounts across household accounts
  within a few days. Get this wrong and every report is garbage.
- **Refunds net against the original category**, they are not income.
- **Splits as child rows** with `split_parent_id` — a Costco run is groceries + household
  + a birthday gift, and forcing one category is a top reason people abandon budgeting apps.

---

## 5. Ingest

### 5.1 Aggregator: Plaid **[ASSUMED]**

You chose "cloud, and maybe others later," which rules out SimpleFIN as the primary —
SimpleFIN is excellent and ~$1.50/mo, but each user manages their own subscription, so it
doesn't onboard other households. Plaid gives the best coverage, the cleanest merchant
enrichment (which directly reduces AI cost, because good merchant names mean the fast path
hits more often), and webhooks.

Cost caveat: Plaid requires a **production access request** describing your use case, and
per-item pricing that you should confirm directly — public pricing shifts, and I won't
quote a number I can't verify. Budget for it exceeding Simplifi.

**Build the ingest layer behind an interface regardless.** `AggregatorAdapter` with
`syncTransactions`, `listAccounts`, `handleWebhook`. Swapping Plaid → SimpleFIN → Teller
then touches one module. If Plaid's production pricing surprises you, that interface is
what saves the project.

### 5.2 Sync mechanics

- Use Plaid's **`/transactions/sync`** cursor endpoint, not the date-range one. It hands
  you added/modified/removed explicitly and is idempotent by design.
- **Pending → posted transitions rewrite amounts.** A $50 restaurant hold becomes $61 with
  tip. Categorize pending transactions optimistically but never fire a clarification on
  one — wait for posted, or you'll ask your wife about a charge that changes tomorrow.
- Webhook receiver does one thing: verify signature, enqueue job, return 200. Nothing else.
- Nightly reconciliation sweep to catch dropped webhooks. They do get dropped.
- **Backfill 12–24 months at setup.** This is not optional — it's what seeds
  `merchant_memory` so day-one categorization is good instead of embarrassing.

---

## 6. The categorization cascade

The instinct is "send every transaction to the LLM." Don't. It's slow, costs money on
transactions you already know the answer to, and is *less accurate* than a lookup for
recurring merchants. Four layers, first match wins:

**Layer 1 — User rules.** Deterministic, always wins, zero cost. If you wrote a rule, the
AI does not get a vote.

**Layer 2 — Merchant memory.** Normalized merchant seen ≥3 times with a consistent
category and a human confirmation? Apply it. This should catch 70–85% of volume once
warmed. Guard it: if the amount is a wild outlier versus history for that merchant,
demote to Layer 3 — your usual $12 Amazon order being $1,400 deserves a fresh look.

**Layer 3 — LLM classification.** Claude Haiku 4.5, structured output via tool use.
Give it: raw description, enriched merchant, amount, date/day-of-week, account type,
card owner, **your actual category list with descriptions**, and 5–10 similar past
transactions with their final categories. Ask for `category`, `confidence`, `reasoning`,
and `alternatives`.

Cost control: put the category taxonomy, rules summary, and instructions in a **cached
prompt prefix** — it's identical across every call. Run the nightly bulk through the
**Batch API** at half price. Only same-day interactive classification needs the sync API.

**Layer 4 — Uncertain → ask a human.** See §7.

**Escalate to Sonnet 5** before giving up: if Haiku's confidence is low but the amount is
large, one better model call is cheaper than an unnecessary interruption to your wife.

### 6.1 Deciding "unsure" — the part that actually matters

**Do not trust self-reported LLM confidence alone.** Models are systematically
overconfident and will say 0.9 on a genuinely ambiguous charge. Combine signals:

1. Self-reported confidence below threshold (start ~0.75, tune against real data)
2. **Top-2 categories close together** — a stronger ambiguity signal than raw confidence
3. No merchant memory *and* amount above a threshold you set
4. Merchant memory exists but this amount is a statistical outlier
5. Category is a catch-all like "Other" / "Uncategorized"
6. Recent human correction on this same merchant — the model was already wrong here

Then apply **interruption budget** rules, because the feature dies if it's annoying:

- Cap clarifications per person per day (start at 3)
- Never ask about anything under a floor (e.g. $25) unless it's a brand-new merchant
- Batch same-day questions into one message with multiple items rather than three pings
- Never ask twice about the same merchant — the first answer becomes a rule
- Quiet hours per user timezone

**Guess-and-confirm beats blocking.** Always assign the best-guess category immediately so
the dashboard is never wrong-by-omission. The clarification *corrects* it. An unanswered
question must never leave a transaction in limbo.

### 6.2 Getting better over time

Every human correction writes to `merchant_memory` and, after the second identical
correction, **proposes a rule** — "You've recategorized Blue Bottle to Coffee twice. Make
it a rule?" One tap. This is the compounding loop that makes month 6 dramatically better
than month 1, and it's the thing Simplifi doesn't do.

Keep a **held-out eval set** of a few hundred hand-labeled transactions. Before changing
a prompt or model, run it. Otherwise you're changing things by vibes and you will silently
regress.

---

## 7. Clarification loop

### 7.1 Routing

`transaction → account → account.owner_user_id → user.telegram_chat_id`. That's the whole
mechanism. Joint accounts need an explicit fallback **[OPEN]** — ask both, ask a designated
default, or infer from history. My recommendation: designated default owner per account,
overridable, with an "ask my spouse instead" button that forwards the question.

### 7.2 Message shape

```
🤔 New charge needs a category

  SQ *THE HIVE MERCANTILE     $47.83
  Tue Aug 4 · Visa ••4412

  My guess: Shopping (62% confident)

  [ Shopping ] [ Groceries ] [ Gifts ]
  [ Something else ] [ 📝 Add memo ]
```

Inline buttons for the top 3 predictions, an "other" that opens a category picker, and a
memo option. Buttons are why this is Telegram and not SMS — one tap versus typing.

### 7.3 Behavior

- Reply writes category + memo, updates merchant memory, resolves the `clarification` row
- **Timeout after 48h** — keep the AI guess, mark it unconfirmed, surface it in the
  dashboard review queue. Never leave it pending forever.
- The dashboard review queue is the catch-all for everything the bot didn't resolve, which
  is your "bring it to the front" requirement in its persistent form
- Free-text replies get parsed by the LLM — "that was for Kate's birthday" should set a
  memo *and* infer Gifts

---

## 8. Rules engine

Rules are stored predicates evaluated before AI, in priority order.

**Conditions:** merchant matches / contains / regex, amount comparisons and ranges,
account, card owner, day of week, date range, description text, pending status. Composable
with AND/OR groups.

**Actions:** set category, add memo, tag, split by fixed amount or percentage, mark as
transfer, exclude from budget, never-ask-about-this.

Requirements that are easy to skip and painful to add later:

- **Retroactive application** with a preview — "this rule matches 47 past transactions,
  apply to them too?" You listed weak rules as a possible Simplifi gripe; retroactivity is
  usually the missing piece.
- **Dry-run** against history before saving
- **Conflict detection** when a new rule overlaps an existing one
- **AI-suggested rules** from correction patterns (§6.2)
- **Match counters** so dead rules are visible and prunable

---

## 9. Budgets, income, savings

**Budget model** **[ASSUMED]:** monthly caps per category, Simplifi-style — familiar, no
behavior change, quick to ship. But include `rollover_cents` on `budget_line` from the
start so envelope/zero-based budgeting is a feature flag rather than a migration.

**Income** falls out of `category.kind = 'income'`. Handle: multiple sources, irregular
timing, and **paycheck splitting** — gross vs net vs deductions is a real modeling
question if you want to track pre-tax retirement contributions **[OPEN]**.

**Savings goals** — the piece most apps do badly. A goal needs to answer "am I on track,"
which means `target_cents`, `target_date`, and progress. Two ways to fund it:

- **Linked account balance** — the goal reflects a real account's balance. Honest, simple.
- **Virtual allocation** — you assign dollars to goals from a general pool. More flexible,
  requires envelope-style accounting to not lie to you.

Start with linked-account **[ASSUMED]**, since it can't drift from reality.

Treat savings contributions as their own `kind`, not an expense. Money moved to savings
isn't spent, and counting it as spending makes your expense numbers meaningless.

---

## 10. Dashboard

**Home — month to date**

- Spent MTD vs budgeted, with **pace indicator** — "you're 60% through the month and 71%
  through the food budget" is the single most useful number and most apps omit it
- Category cards sorted by percentage of budget consumed, over-budget surfaced first
- Income received vs expected
- Savings goal progress
- **Needs review queue** — pinned, unmissable, containing unanswered clarifications,
  low-confidence categorizations, and uncategorized items

**Transactions** — fast search/filter, inline category editing, bulk recategorize,
split, memo. Show *why* something was categorized (rule / memory / AI + confidence).
That transparency is what builds trust in the AI.

**Budgets** — edit caps for the current or future month, copy last month forward, see
3-month trailing average per category as a sanity check on the cap you're setting.

**Rules** — list with match counts, create/edit with live preview, review AI suggestions.

**Later:** trends over time, spending by owner, recurring/subscription detection,
net worth. Not v1.

---

## 11. Security

This is the highest-consequence data you own. Non-negotiables:

- **Never store bank credentials.** Plaid Link handles auth; you hold an access token only.
- **Encrypt aggregator access tokens at rest** with a KMS-managed key, not an env-var
  string constant.
- Household-scoped queries enforced at the data layer — a `WHERE household_id` you can
  forget to write is a data breach waiting to happen. Prefer Postgres RLS.
- MFA on the app, and on your Plaid and hosting accounts.
- **Telegram chat ID verification** during onboarding — a bot token leak plus a guessed
  chat ID should not leak transactions. Verify with a one-time code.
- Webhook signature verification on every inbound Plaid and Telegram call.
- Redact account numbers in logs. Never log full transaction payloads in production.
- **What goes to the Claude API:** merchant name, amount, date, category list. Not account
  numbers, not your name, not balances. Worth deciding deliberately and documenting.
- Automated Postgres backups with a tested restore. Untested backups aren't backups.

If other households ever use this, you're handling other people's financial data — that
changes your legal exposure meaningfully, and is worth real thought before you invite
anyone.

---

## 12. Cost

| Item | Estimate |
|---|---|
| Plaid | **Verify directly** — production pricing is per-item and changes |
| Hosting (Vercel/Fly + Neon) | $0–25/mo, likely free tier at your volume |
| Claude API | Well under $1/mo — Haiku + prompt caching + Batch API + a fast path that skips the LLM on most transactions |
| Telegram | Free |
| **vs Simplifi** | ~$4–6/mo |

The AI is the cheapest part of this by an order of magnitude. The aggregator is the whole
cost question. If Plaid's pricing comes back unattractive, SimpleFIN at ~$1.50/mo makes
the entire thing cost less than Simplifi — which is exactly why §5.1 insists on the
adapter interface.

---

## 13. Roadmap

**Phase 0 — Foundations (~1 week)**
Repo, Next.js + Postgres + auth, household/user/account/transaction/category schema,
seed a category taxonomy **exported from Simplifi so history maps cleanly**, CSV import
so there's real data to work with before any aggregator exists.

*Milestone: your Simplifi export is queryable in your own database.*

**Phase 1 — Ingest (~1 week)**
Aggregator adapter interface, Plaid Link flow, `/transactions/sync`, webhook receiver +
queue, dedupe, 24-month backfill, transfer detection, nightly reconciliation.

*Milestone: transactions appear automatically, no duplicates, transfers excluded.*

**Phase 2 — Categorization (~1–2 weeks)**
Rules engine + evaluator, merchant memory, Claude classification with structured output,
prompt caching, batch nightly runs, the classification audit table, hand-label an eval set.

*Milestone: >85% of a held-out month categorized correctly with zero human input.*

**Phase 3 — Dashboard (~1–2 weeks)**
MTD view with pace, budget CRUD, transaction list with inline edit and split, review
queue, rules UI with retroactive preview.

*Milestone: you stop opening Simplifi.*

**Phase 4 — Clarification loop (~1 week)**
Telegram bot, onboarding both phones, uncertainty detection, owner routing, inline
keyboards, reply handling, timeouts, interruption budget, correction→rule suggestions.

*Milestone: a genuinely ambiguous charge reaches the right phone the same day.*

**Phase 5 — Polish**
Savings goals, income tracking, recurring detection, trends, spouse read-only vs edit
permissions, export.

Phases 0–3 are the actual replacement. Phase 4 is the reason you're building it instead of
buying it. **Run Simplifi in parallel through Phase 3** and reconcile monthly — do not cancel
until your numbers match theirs two months running.

---

## 14. Open questions

Answers to these change the plan. Grouped by how much they'd cost to get wrong.

### Blocking — would cause rework

1. **Aggregator confirmed?** Plaid assumed. If cost matters more than onboarding other
   households, SimpleFIN changes Phase 1 and cuts monthly cost below Simplifi.
2. **Budget model?** Monthly caps assumed. Zero-based/envelope is a different ledger and
   is genuinely harder — worth knowing now, not in Phase 3.
3. **Which banks and cards specifically?** Coverage varies enormously. One credit union
   that no aggregator supports well changes the answer to #1.
4. **Joint accounts — who gets asked?** §7.1. Affects routing logic and the account schema.

### Shaping — changes priorities

5. **What actually frustrates you about Simplifi?** Miscategorization, broken connections,
   weak rules, or bad reporting? If it's broken connections, note that building your own
   does *not* fix that — it's an aggregator problem and you'd inherit it.
6. **Can you export Simplifi history, and how far back?** Determines how good day-one
   categorization is.
7. **Your category taxonomy** — reuse Simplifi's exactly, or redesign? Reusing makes
   historical comparison possible.
8. **Does your wife want to use the dashboard, or only answer Telegram prompts?** Decides
   whether Phase 3 needs real multi-user permissions or just two logins.
9. **What's your realistic weekly time budget?** Phases 0–3 at a few hours a week is
   roughly a quarter. Worth calibrating before you cancel anything.

### Refinement — can be decided later

10. Pre-tax deductions and gross-vs-net paycheck tracking — needed, or is net enough?
11. Savings goals: linked account balance or virtual allocation?
12. Investment and retirement accounts — track balances, or out of scope for v1?
13. Any shared/split expenses with people outside the household to track?
14. Mobile: responsive web enough, or do you want an installable PWA?
15. Was SMS a hard requirement for a reason not stated, or is Telegram fine?
16. Cash spending — track manually, or ignore it?
