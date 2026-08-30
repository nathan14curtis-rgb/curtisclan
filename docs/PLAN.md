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

### 4.0 Plaid Trial plan covers your banks, free

Your accounts are **Chase, Discover, and Amex**. Chase and Amex are OAuth institutions,
which normally means full Production access plus a security questionnaire. But Plaid's
**Trial plan** gives free access to real production data with **no business registration,
no security questionnaire, and no contract**, and its OAuth coverage explicitly includes
Chase and American Express. Transactions is one of the bundled products.

**The cap is 10 Production Items.** You need three. Two constraints follow:

- **`/item/remove` does not free a slot against the 10-Item cap.** Burn slots on repeated
  test links and you cannot get them back. **Build and debug the entire Link flow against
  Sandbox**, and only link real Chase/Discover/Amex accounts once it works end to end.
- Adding a checking account and a savings account later still leaves headroom, but the cap
  is the reason to be deliberate about every real link you create.

This makes Plaid **free** for your use case, which changes the cost picture in §11
substantially. Verify the current Trial terms when you sign up — plan details move.

### 4.1 You own the Plaid integration end to end

No Replit connector — everything Plaid-side is yours to build on Workers:

- **Link flow.** Plaid Link web SDK in the dashboard, backed by two Worker endpoints:
  one to create a `link_token`, one to exchange the returned `public_token` for a
  permanent `access_token`. The exchange must happen server-side; a `public_token` is
  short-lived and the `access_token` must never reach the browser.
- **Token encryption.** `access_token` per item, encrypted at rest in D1 with **AES-GCM
  via the Workers Web Crypto API**, key held in Workers Secrets. Workers has Web Crypto
  natively, so this is straightforward — but a plaintext token column is a full read of
  every linked account, so treat it as the one thing not to defer.
- **Webhook verification.** Plaid signs webhooks with a **JWT (ES256)** verified against a
  key from `/webhook_verification_key/get`. Workers' Web Crypto can do ES256, but this is
  real work, not a header comparison. Don't skip it and don't "add it later" — an
  unverified webhook endpoint lets anyone inject transactions into your ledger.
- **Re-auth handling.** Items break: expired credentials, MFA changes, bank migrations.
  Plaid signals this via `ITEM_LOGIN_REQUIRED`. Catch it, mark the account, and surface a
  re-link prompt in the dashboard. Skip this and the app silently stops seeing a card.

### 4.2 Sync mechanics

- Use Plaid's **`/transactions/sync`** cursor endpoint, not date ranges. It returns
  added/modified/removed explicitly and is idempotent by design.
- Webhook Worker does exactly three things: **verify signature, enqueue, return 200.**
  Plaid retries on timeout — do real work in the request and you will double-process.
- **Ask on pending, not posted.** Credit cards can sit pending for **1–3 days**, so waiting
  for posted means asking "what was that $35 at Walmart?" three days later — exactly when
  you can no longer remember. Ask while it's fresh. The amount changing doesn't invalidate
  the answer: a $50 hold posting as $61 with tip is still dining, and the memo "lunch with
  a friend" is still true.
- **Carry the category across the pending→posted transition.** Plaid removes the pending
  transaction, fires `TRANSACTIONS_REMOVED`, and returns a new posted transaction carrying
  **`pending_transaction_id`** pointing at the removed one. Use it to move your category,
  memo, and clarification history onto the posted row. Get this wrong and you re-ask about
  every transaction twice.
- **Handle the unmatched case.** Plaid occasionally fails to pair them: the posted
  transaction arrives with **no** `pending_transaction_id` and the pending one is removed
  anyway. Fall back to matching on account + similar amount + merchant within a short date
  window. If that misses too, `merchant_memory` has already learned the merchant, so the
  re-categorization is usually silent.
- **Nightly cron reconciliation** to catch dropped webhooks. They get dropped.
- **Backfill 12–24 months at setup.** This is what seeds `merchant_memory` so the app is
  smart on day one instead of asking you about all 40 of your recurring merchants.

---

## 5. The iMessage loop

This is the part with real design risk, and it isn't the AI.

### 5.0 Onboarding: contact verification is required

On Sendblue's **free shared-line plan**, you cannot message an arbitrary number. Each
recipient must be **verified once**: add them via the Sendblue CLI, then have them text
your Sendblue number a single time. After that handshake the app can initiate freely.

For two contacts this is a one-time five-minute step, not an ongoing constraint. Two
consequences for the build:

- **It pairs with the security requirement in §10.** You need to bind `from_number` to a
  verified user anyway, since `from_number` is the only thing authenticating an inbound
  reply. Sendblue's verification handshake is a natural place to do that binding.
- **Free plans use a shared line** — the number your wife texts is shared with other
  Sendblue customers' apps rather than dedicated to you. Fine for testing whether the loop
  helps. Worth revisiting **[OPEN]** if this becomes something you both use daily: a
  dedicated number is a nicer experience and isn't subject to reassignment.

**Check Sendblue's rate limits before Phase 3.** Immediate-send is bursty — several
transactions can post at once and generate several messages in the same second. Their docs
have a rate-limit and message-queue page; make sure the send path queues rather than
fires in parallel.

### 5.1 The correlation problem

Sendblue inbound webhooks give you `from_number` and `content`. **They do not tell you
which question the reply answers.** Correlation is entirely your job.

Rather than avoid the problem by keeping one question open at a time, lean into it:
**send a batched digest and resolve many answers from one reply.** One Claude call takes
the reply plus every open transaction for that number and returns the pairings.

Dedupe every inbound on `message_handle` — Sendblue can redeliver, and a redelivered
reply must not double-apply.

### 5.2 Digest and batch resolution

**The digest:**

```
3 charges need categories:

1. $35.00 — WALMART · Tue
2. $25.00 — STARBUCKS · Tue
3. $14.00 — MAVERIK · Wed
```

**Any of these replies must work:**

- `walmart was groceries, starbucks was coffee, maverik was gas`
- `1 groceries 2 coffee 3 gas`
- `all groceries except maverik was gas`
- `the big one was groceries, rest was food`
- `first two were work stuff` *(partial — leaves #3 open)*

Numbering is there as a convenience, not a requirement. The model gets merchant, amount,
date, and account for every open item, so it can resolve by any attribute you happen to
use.

**Resolver output** — structured, one call:

```
matches:      [{ transaction_id, category_id, memo, confidence, source_span }]
unmatched:    [transaction_id]      // still open, re-ask later
unresolved:   string                // text that answered nothing
```

`source_span` records which part of your reply drove each match. Costs nothing to store
and is what lets you debug a bad pairing months later.

**Four cases the resolver must handle explicitly:**

- **Partial answers.** Apply what was answered, leave the rest open, re-ask only those.
  Never force a guess to close out a batch.
- **Duplicate merchants in one batch.** Two Starbucks charges, one "starbucks was coffee":
  if the answer resolves the same way, apply to both. If you said "the $25 one",
  amount-match. If it's genuinely ambiguous *and* would resolve differently, send a
  targeted follow-up instead of guessing.
- **Out-of-order replies.** You answer yesterday's digest after today's has arrived. Match
  against **all** open clarifications for that number, not just the newest batch.
- **Per-match confidence.** A low-confidence pairing does not auto-apply — it goes into
  the confirmation as a question rather than a statement.

### 5.3 The confirmation message is not optional

One-at-a-time is self-correcting: the question names one charge, so a wrong answer is
visibly wrong. **Batching removes that.** If the model pairs "coffee" with the Maverik
charge, the record is wrong, nothing looks broken, and your gas budget quietly drifts.

So every batch resolution sends back:

```
Got it:
✓ Walmart $35 → Groceries
✓ Starbucks $25 → Coffee
✓ Maverik $14 → Gas

Reply "fix walmart" if I got one wrong.
```

One extra message, and it turns an invisible error into a two-second correction. A "fix X"
reply reopens just that transaction.

### 5.4 Parsing individual answers

Within the batch resolver, each answer produces `category_id`, `memo`, `confidence`, and
`suggested_rule`. The memo is stored **verbatim** — in six months "lunch with a friend" is
more useful to you than "Dining Out".

Handle the awkward inputs deliberately: a reply that asks a question back, a category name
that doesn't exist, an implied split ("half groceries half booze"), a correction to an
already-closed transaction ("actually that Amazon was a gift"), and text that isn't about
money at all. When nothing is open, a reply falls through to intent parsing — corrections
and questions like "how much on food this month?" both come out of the same call.

### 5.5 How often to ask — starting with immediate

**Decision: send immediately on each new transaction**, to find out whether the prompt
actually helps you organize spending. That's the right experiment — the value of asking in
the moment is exactly what's unproven, and a daily digest would confound it with a recall
delay.

Two things make this work better than it did in the original one-at-a-time design:

1. **The batch resolver still applies.** Immediate sending means several questions are open
   at once — which is the same situation as a digest, just arrived separately. You get
   three texts and answer once: *"walmart was groceries, starbucks was coffee, maverik was
   gas."* §5.2 handles it unchanged. Answer whenever you want, in whatever grouping.
2. **Asking on pending, not posted** (§4.2) means the text arrives while you still
   remember the purchase.

Keep from day one, because they're cheap and you'll want them:

- **Quiet hours** per user timezone. Queue overnight, send in the morning.
- **Never ask twice about the same merchant** — the first answer writes `merchant_memory`.
  This alone kills most of the repetitive volume without any threshold tuning.
- **Always assign a best guess immediately.** The text *corrects* the record; it never
  blocks it. An unanswered message must never leave a transaction uncategorized.
- **Time out after 48h**, keep the guess, flag it in the dashboard review queue.

**Instrument the experiment.** Track answer rate and median time-to-reply per person, and
chart it in the dashboard. That number is the honest verdict on whether this feature helps:
if it stays high, immediate sending is working; when it falls off, that's the data telling
you to gate. Build the gating thresholds (dollar floor, confidence, novelty, daily cap)
behind config so you can turn them on the day it starts to grate, without a rewrite.

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
| Plaid | **$0** on the Trial plan — 3 of 10 Items used (§4.0) |
| Sendblue | **$0** on the free shared-line plan — 2 verified contacts (§5.0) |
| Claude API | Well under $1/mo with the cascade, prompt caching, and Batch API |
| **Total** | **~$5/mo**, essentially all Cloudflare |
| **vs Simplifi** | ~$4–6/mo |

Both external services that I expected to dominate the cost are free at your scale: Plaid's
Trial plan covers Chase, Discover, and Amex, and Sendblue's free tier covers two verified
contacts. The entire recurring cost is the $5 Cloudflare Workers Paid plan you need for
Queues, plus pennies of Claude usage.

That means this genuinely does replace Simplifi at lower cost — which I told you earlier it
probably wouldn't. The build time is still the real price, and the reason to do it is still
the loop in §5.

**Where cost would appear later:** outgrowing Plaid's 10-Item cap, moving to a dedicated
Sendblue number, or opening this up to other households — any of which converts a free tier
into a paid one.

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
1. **Is any of Chase/Discover/Amex a checking or savings account, or are all three credit
   cards?** Discover and Amex are card-only. If Chase is also a card, then **nothing in
   this plan can see your income or your savings** — paychecks land in a checking account
   that isn't linked, savings goals have no balance to track, and card payments will look
   like income unless suppressed. Your original ask was to sort income, expenses, *and*
   savings goals; only expenses work with cards alone. Linking a checking account is the
   single highest-value thing you can add, and you have 7 free Item slots.
2. **Budget model** — monthly caps, or zero-based/envelope with rollover? This shapes the
   schema, so it's worth settling before Phase 0. **This is the last thing blocking Phase 0.**

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
