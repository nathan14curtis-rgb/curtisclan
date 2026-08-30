# Curtis Clan — AI Budgeting App

Replace Quicken Simplifi with a self-owned budgeting app on Cloudflare, fed by Plaid,
with an iMessage loop that asks what a charge was and understands the answer in plain English.

> **Status:** planning only. No code written yet.
> **[ASSUMED]** marks my recommendation standing in for an unanswered question.
> **[OPEN]** marks a decision I need from you — see [§13](#13-open-questions).

---

## 1. The core loop

```
Plaid webhook  →  new transaction  →  categorize
                                          │
                              confident ──┴── unsure
                                  │             │
                                  │             ▼
                                  │      iMessage via Sendblue:
                                  │      "$47.83 at THE HIVE MERCANTILE.
                                  │       What was this?"
                                  │             │
                                  │      "lunch with a friend"
                                  │             │
                                  │             ▼
                                  │      Claude parses → Dining Out
                                  │      + memo "lunch with a friend"
                                  │             │
                                  ▼             ▼
                          ┌──────────────────────────┐
                          │  D1 ledger → dashboard   │
                          └──────────────────────────┘
```

The unstructured reply is the whole point. You should never have to remember a category
name, a keyword, or a reply format. You type what happened; the model does the filing.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Compute | **Cloudflare Workers** (Hono) | API, Plaid webhook, Sendblue webhook, dashboard serving |
| Database | **Cloudflare D1** | SQLite. Right size for this; integer-cents money maps cleanly |
| Async | **Cloudflare Queues** | Webhook receives → enqueue → process. Requires Workers Paid |
| Scheduled | **Cron Triggers** | Nightly reconciliation, batch categorization, budget rollover |
| Secrets | **Workers Secrets** | Plaid, Sendblue, Anthropic keys |
| Dashboard | **React + Vite on Workers Assets** | SPA served from the same Worker as the API |
| AI | **Claude Haiku 4.5**, escalating to Sonnet 5 | Classification + reply parsing |
| Banking | **Plaid** | `/transactions/sync` + webhooks |
| Messaging | **Sendblue** | iMessage send + inbound webhook |

Cloudflare is a genuinely good fit here, for a specific reason: this app is mostly
*webhooks and cron*, not sustained compute. Two inbound webhook endpoints, a queue
consumer, a nightly job, and a small dashboard. That's the shape Workers is best at, and
it costs ~$5/mo.

### Two Cloudflare gotchas to plan around

1. **Plaid's official Node SDK is axios-based** and fights the Workers runtime. Call
   Plaid's REST API directly with `fetch`, or enable `nodejs_compat` and test early.
   Do not discover this in week three.
2. **Workers have CPU time limits per invocation.** Categorizing a 24-month backfill of
   several thousand transactions must run through Queues in batches, not in one request.

---

## 3. Data model

Entities, not schema code. All money as **signed integer cents** — never floats. D1 is
SQLite, which has no decimal type, so this is doubly non-negotiable.

**Core**
- `household` — tenant boundary. Every query filters on it.
- `user` — belongs to household. Holds **`phone_e164`** (the Sendblue routing key),
  timezone, quiet hours, notification prefs.
- `account` — one per card/bank account. **`owner_user_id`** is what routes a question to
  the right person. Plus `plaid_item_id`, `plaid_account_id`, `mask` (last 4), `type`.
- `transaction` — `account_id`, `posted_at`, `amount_cents`, `raw_description`,
  `normalized_merchant`, `category_id`, `memo`, `pending`, `plaid_txn_id` (unique —
  your idempotency key), `is_transfer`, `split_parent_id`.
- `transaction_classification` — separate table on purpose. `method`
  (rule/memory/llm/human), `confidence`, `model`, `reasoning`, `alternatives`,
  `prompt_version`. This is your audit trail *and* your eval set. Without it you can't
  answer "did categorization improve after I changed the prompt?"

**Budgeting**
- `category` — hierarchical, with `kind` ∈ {expense, income, savings, transfer}. This one
  field is what makes "sort my income, expenses, and savings goals" fall out of the data
  model instead of being hardcoded into every query.
- `budget_period` — one per household per month; snapshots caps so editing this month
  doesn't rewrite history.
- `budget_line` — `category_id`, `limit_cents`, `rollover_cents` (unused at first, present
  so envelope budgeting is a feature flag rather than a migration).
- `savings_goal` — `target_cents`, `target_date`, `linked_account_id`.

**The messaging loop**
- `clarification` — `transaction_id`, `user_id`, `status`
  (queued → sent → answered | timed_out), `sent_at`, `sendblue_handle`, `question_text`.
  The state machine that makes reply-matching work (§5).
- `inbound_message` — raw Sendblue payloads, deduped on `message_handle`. Keep these;
  when reply parsing misfires you will want the original text.
- `merchant_memory` — `normalized_merchant` → `category_id`, `hit_count`,
  `last_confirmed_at`. The fast path that keeps AI cost near zero.
- `rule` — `priority`, `conditions` (JSON predicate tree), `actions`, `source`
  (user/ai_suggested), `match_count`.

**Three modeling calls that break everything if wrong**
- **Transfers are not expenses.** A card payment from checking is one movement, not income
  plus expense. Detect by matching opposite-signed amounts across household accounts within
  a few days.
- **Refunds net against the original category.** They are not income.
- **Splits are child rows** via `split_parent_id`. A Costco run is groceries + household +
  a gift, and forcing one category is a top reason people quit budgeting apps.

---

## 4. Ingest

- Use Plaid's **`/transactions/sync`** cursor endpoint, not date ranges. It returns
  added/modified/removed explicitly and is idempotent by design.
- Webhook Worker does exactly three things: **verify signature, enqueue, return 200.**
  Plaid retries on timeout — do real work in the request and you will double-process.
- **Pending transactions rewrite themselves.** A $50 restaurant hold posts as $61 with tip.
  Categorize pending optimistically, but **never send an iMessage about a pending
  transaction** — you'll ask about a charge whose amount changes tomorrow. Wait for posted.
- **Nightly cron reconciliation** to catch dropped webhooks. They get dropped.
- **Backfill 12–24 months at setup.** This is what seeds `merchant_memory` so the app is
  smart on day one instead of asking you about all 40 of your recurring merchants.

---

## 5. The iMessage loop

This is the part with real design risk, and it isn't the AI.

### 5.1 The correlation problem

Sendblue inbound webhooks give you `from_number` and `content`. **They do not tell you
which question the reply answers.** If you sent two questions and get back "lunch with a
friend," nothing in the payload says which transaction that belongs to.

Three ways to solve it, in the order I'd apply them:

1. **One open question per person at a time.** Default. Others sit in `queued`. A reply is
   unambiguous because only one question is outstanding. Costs you throughput — if you ask
   3x/day this is fine; it wouldn't be if you asked about everything.
2. **LLM disambiguation** when more than one is open. Pass the reply plus all outstanding
   transactions to Claude and let it pick — "lunch with a friend" obviously matches the
   $23 restaurant charge, not the $60 gas. This is what makes batching safe later.
3. **Fall through to intent parsing** when nothing is open. A text that isn't answering
   anything is either a correction ("actually that Amazon was a gift") or a question
   ("how much have I spent on food this month?"). Both are worth supporting and both fall
   out of the same parse step.

Dedupe every inbound on `message_handle` — Sendblue can redeliver.

### 5.2 Parsing the reply

One Claude call with structured output. Input: the reply text, the transaction, your
category list with descriptions, and a few similar past transactions. Output:
`category_id`, `memo`, `confidence`, `is_correction`, `suggested_rule`.

"lunch with a friend" → category `Dining Out`, memo `lunch with a friend`. The memo is
stored verbatim, because in six months "lunch with a friend" is more useful to you than
"Dining Out" alone.

Handle the awkward cases explicitly: a reply that answers with a *question*, a reply
naming a category that doesn't exist, a reply that implies a split ("half groceries half
booze"), and a reply that's clearly not about money at all.

### 5.3 Message shape

iMessage has no buttons. Plain text only, which is why unstructured replies aren't a
compromise here — they're the only option, and they happen to be what you want.

```
💳 $47.83 — THE HIVE MERCANTILE
Tue Aug 4 · Visa ••4412

What was this?
```

Short. No category menu, no reply-format instructions. If a guess is high-confidence but
below the auto-apply bar, say it ("Guessing: Shopping") so a one-word "yep" works.

### 5.4 How often to ask — the thing that will kill this feature

You described asking on **every** new transaction. Two to four cards run **80–150
transactions a month**. That's 3–5 texts a day, forever, most of them about the same
Starbucks. The feature dies in week two and takes the app with it.

What I'd build instead — **[ASSUMED]**, and easy to change since it's all thresholds:

- **Training mode for the first 2–3 weeks.** Ask aggressively, because every answer writes
  to `merchant_memory` and you're bootstrapping. High interruption, high value, and you
  *know* it's temporary.
- **Then decay to asking only when it matters:** new merchant, low confidence, top-two
  categories close together, amount well outside the norm for that merchant, or above a
  dollar floor you set.
- **Hard caps:** max N questions per person per day (start at 3), quiet hours in their
  timezone, never ask twice about the same merchant.
- **Always assign a best guess immediately.** The question *corrects* the record, it
  doesn't block it. An unanswered text must never leave a transaction uncategorized.
- **Time out after 48h**, keep the guess, flag it in the dashboard review queue.

Same mechanism you asked for. Just gated, so it stays livable past month one.

### 5.5 The compounding loop

Every human answer writes `merchant_memory`. The second time you correct the same
merchant, the app texts back: *"Want me to always file Blue Bottle as Coffee?"* — "yes"
creates a rule.

This is the entire reason to build rather than buy. Simplifi's categorization is the same
in month 12 as month 1. Yours should be asking you almost nothing by then.

---

## 6. Categorization cascade

Don't send every transaction to the LLM. It's slower, costs money on transactions you
already know, and is *less accurate* than a lookup for recurring merchants. Four layers,
first match wins:

1. **User rules** — deterministic, always win, zero cost.
2. **Merchant memory** — merchant seen ≥3 times with a consistent, human-confirmed
   category. Should absorb 70–85% of volume once warm. Guard it: an amount far outside
   the norm for that merchant demotes to layer 3.
3. **Claude Haiku 4.5** — structured output. Give it description, merchant, amount,
   day of week, account type, card owner, your category list, and 5–10 similar past
   transactions with their final categories. Put the taxonomy and instructions in a
   **cached prompt prefix** (identical every call) and run nightly bulk through the
   **Batch API** at half price. Escalate to **Sonnet 5** when confidence is low and the
   amount is large — one better model call is cheaper than an unnecessary interruption.
4. **Ask a human** — §5.

**Don't trust self-reported confidence alone.** Models are overconfident and will claim
0.9 on a genuinely ambiguous charge. Combine it with top-two margin, merchant novelty,
amount outlier status, and whether you recently corrected this merchant.

Keep a **held-out eval set** of a few hundred hand-labeled transactions. Run it before
changing a prompt or model, or you're tuning by vibes and will silently regress.

---

## 7. Rules engine

Stored predicates, evaluated before AI, in priority order.

**Conditions:** merchant matches/contains/regex, amount comparisons and ranges, account,
card owner, day of week, date range, description text. AND/OR groups.
**Actions:** set category, add memo, tag, split by amount or percent, mark transfer,
exclude from budget, never-ask-about-this.

Easy to skip, painful to retrofit:
- **Retroactive application with preview** — "matches 47 past transactions, apply to those too?"
- **Dry run** against history before saving
- **AI-suggested rules** from correction patterns (§5.5)
- **Match counters** so dead rules are visible

---

## 8. Budgets, income, savings

**Budget model [ASSUMED]:** monthly caps per category, Simplifi-style. Familiar, quick to
ship, no behavior change. But carry `rollover_cents` on `budget_line` from day one so
envelope budgeting is a flag, not a migration.

**Income** falls out of `category.kind = 'income'`. Handles multiple sources and irregular
timing. Gross vs net and pre-tax deductions is a real modeling question **[OPEN]**.

**Savings goals** need to answer "am I on track": `target_cents`, `target_date`, progress.
Fund them from a **linked account balance [ASSUMED]** rather than virtual allocation —
it can't drift from reality, and virtual allocation really wants envelope accounting
underneath it.

Savings contributions are their own `kind`, not an expense. Money moved to savings isn't
spent, and counting it as spending makes every expense number meaningless.

---

## 9. Dashboard

**Home — month to date**
- Spent vs budgeted, with a **pace indicator**: "60% through the month, 71% through food."
  The single most useful number, and most apps omit it.
- Category cards sorted by budget consumed, over-budget first
- Income received vs expected · savings goal progress
- **Needs-review queue**, pinned — unanswered texts, low-confidence guesses, uncategorized

**Transactions** — search/filter, inline category edit, bulk recategorize, split, memo.
Show *why* something was categorized (rule / memory / AI + confidence, and the iMessage
reply if there was one). That transparency is what makes you trust it.

**Budgets** — edit caps for current or future months, copy last month forward, show a
3-month trailing average as a sanity check on the cap you're setting.

**Rules** — list with match counts, create/edit with live preview, review AI suggestions.

---

## 10. Security

Highest-consequence data you'll ever own.

- **Never store bank credentials.** Plaid Link handles auth; you hold an access token.
- **Encrypt Plaid access tokens at rest.** Workers Secrets for app-level keys; per-item
  tokens encrypted in D1 with a key from Secrets — not a constant in source.
- **Verify both webhook signatures.** Plaid's JWT verification and Sendblue's secret
  header. An unverified webhook endpoint is an open door to your ledger.
- **Verify phone numbers at onboarding.** `from_number` is the *only* thing authenticating
  an inbound reply. Spoofing is the obvious attack: a text that categorizes transactions
  is low-value to an attacker, but one that *reads back* spending is not. Never let an
  inbound text disclose data before the number is bound to a verified user.
- **Household-scoped queries at the data layer**, not by remembering a `WHERE` clause.
- **What goes to Claude:** merchant, amount, date, category list, your reply text. Not
  account numbers, not balances, not names. Decide this deliberately and write it down.
- Redact account numbers in logs. Never log full transaction payloads.
- D1 backups with a **tested restore**. Untested backups aren't backups.

---

## 11. Cost

| Item | Estimate |
|---|---|
| Cloudflare Workers Paid | ~$5/mo (needed for Queues) |
| D1 | Free tier likely sufficient |
| Plaid | **Verify directly** — per-item, and the real cost question |
| Sendblue | **Verify** — per-message or subscription |
| Claude API | Well under $1/mo with the cascade, prompt caching, and Batch API |
| **vs Simplifi** | ~$4–6/mo |

The AI is the cheapest line by an order of magnitude. Plaid and Sendblue decide whether
this beats Simplifi on price. It may not — build it for the loop in §5, not to save $6.

---

## 12. Roadmap

**Phase 0 — Foundations (~1 week)**
Worker + Hono + D1 + migrations, household/user/account/transaction/category schema,
category taxonomy **exported from Simplifi** so history maps cleanly, CSV import.
*Milestone: your Simplifi history is queryable in your own database.*

**Phase 1 — Ingest (~1 week)**
Plaid Link, `/transactions/sync`, webhook Worker → Queue, dedupe, 24-month backfill,
transfer detection, nightly cron reconciliation.
*Milestone: transactions arrive automatically, no duplicates, transfers excluded.*

**Phase 2 — Categorization (~1–2 weeks)**
Rules engine, merchant memory, Claude classification with structured output and prompt
caching, batch backfill through Queues, classification audit table, hand-labeled eval set.
*Milestone: >85% of a held-out month correct with zero human input.*

**Phase 3 — iMessage loop (~1–2 weeks)**
Sendblue send + inbound webhook, phone verification, clarification state machine,
one-open-question queueing, unstructured reply parsing, disambiguation, timeouts,
rate limits and quiet hours, correction→rule suggestions.
*Milestone: an ambiguous charge reaches the right phone and "lunch with a friend" files it.*

**Phase 4 — Dashboard (~1–2 weeks)**
MTD with pace, budget CRUD, transaction list with inline edit and split, review queue,
rules UI with retroactive preview.
*Milestone: you stop opening Simplifi.*

**Phase 5 — Polish**
Savings goals, income tracking, recurring detection, trends, spouse permissions, export.

**Run Simplifi in parallel through Phase 4** and reconcile monthly. Don't cancel until
your numbers match theirs two months running.

---

## 13. Open questions

### Blocking
1. **Which Plaid setup do you have?** If it's the *Replit* Plaid connector, it doesn't
   travel to Cloudflare — that connector handles Link and token storage inside Replit's
   platform. On Workers you need your own Plaid account and you build the Link flow and
   token encryption yourself. This changes Phase 1 materially.
2. **Do you have Plaid production access, and at which banks?** Chase, BofA, and Citi
   require production approval and a security questionnaire. Which cards are these?
3. **Ask on every transaction, or gated by uncertainty?** §5.4. I've assumed gated with a
   training-mode ramp. If you truly want every one, say so and I'll drop the caps — but
   the one-open-question-at-a-time design has to change too.
4. **Budget model** — monthly caps, or zero-based/envelope with rollover?

### Shaping
5. **"The customer"** — is this just you and your wife, or are you building toward other
   people using it? Multi-tenant is cheap now and brutal to retrofit, but holding other
   people's bank data is a serious step.
6. **Two phone numbers, two people?** Card-owner routing assumes yes. What happens on a
   joint account — ask a designated default, or ask both?
7. **Can you export Simplifi history, and how far back?** Determines day-one quality.
8. **Keep Simplifi's category taxonomy or redesign?** Reusing makes historical comparison work.
9. **Does your wife want dashboard access, or only the texts?**

### Refinement
10. Gross vs net paycheck tracking — needed, or is net enough?
11. Investment/retirement balances — in scope for v1?
12. Cash spending — track manually, or ignore?
13. Should the text channel also answer questions ("how much on food this month?"), or
    only categorize?
