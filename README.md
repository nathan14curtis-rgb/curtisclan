# Curtis Clan

Self-owned budgeting app on Cloudflare Workers, fed by Plaid, with an
iMessage loop that asks what a charge was and understands the answer in
plain English. Full design in [`docs/PLAN.md`](docs/PLAN.md).

## What's built

**Phase 0 (Foundations):** Worker + Hono + D1, the full data model
(`migrations/*.sql`), a household-scoped data access layer, the default
category taxonomy with auto-created envelopes, CSV import, and a REST API
over all of it.

**Phase 1 (Plaid ingest):** Link flow (`src/routes/plaid.ts`), a
fetch-based Plaid REST client (`src/plaid/client.ts` — the official SDK is
axios-based and fights the Workers runtime, PLAN.md §2), ES256 webhook JWT
verification with a real crypto round-trip test (`src/plaid/webhookAuth.ts`),
`/transactions/sync` cursor-based ingest with pending→posted carry-over
and transfer detection (`src/plaid/sync.ts`, `src/db/transfers.ts`),
`ITEM_LOGIN_REQUIRED` handling, and nightly cron reconciliation.

**Phase 2 (Categorization):** the full four-layer cascade — rules, merchant
memory, a real Claude Haiku 4.5 call (escalating to Sonnet 5 on low
confidence) via the official `@anthropic-ai/sdk`, strict structured tool
output, prompt caching on the taxonomy, and a Batch API path for future
bulk backfills (`src/categorization/llm.ts`).

**Phase 3 (iMessage loop):** Sendblue send/inbound webhooks, phone
verification via `POST /:householdId/users/:userId/verify-phone`, the
batched reply resolver (PLAN.md §5.2 — one Claude call pairs a free-text
reply against every open clarification), the confirmation message
(§5.3), a "fix &lt;merchant&gt;" correction flow, and quiet-hours-aware
sending via a low-concurrency outbound queue.

**One shared group chat, not per-owner 1:1 texts:** every clarification,
confirmation, and correction goes to a single household-level iMessage
group thread (`src/messaging/groupChat.ts`) instead of whichever spouse
owns the card that charge landed on. This is the answer to PLAN.md §13
Q6 ("ask a designated default, or ask both?") the household actually
wanted: ask everyone, in one thread. The group is created on the first
message (Sendblue's `/send-group-message` with every verified number) and
its `group_id` is reused for every later send; either spouse can answer
any open charge (attributed to whoever actually replied), and quiet hours
now wait for *whichever* spouse's window ends latest rather than one
fixed recipient's. Since the recipient is no longer implicitly "the card
owner," each question names the account too: `"$47.83 at THE HIVE
MERCANTILE (Amex). What was this?"`

**121 tests**, `vitest run` green, `tsc --noEmit` clean. Pure logic is
tested directly (including a real generated ES256 keypair signing/
verifying an actual JWT — not a mocked crypto call); D1-backed code runs
against a real migrated database via `@cloudflare/vitest-pool-workers`
(miniflare), including the group-send/quiet-hours paths tested against a
real D1 + a stubbed `fetch` intercepting the Sendblue call; the
Claude-calling code is tested against a fake `Anthropic` client double,
since this environment holds no live API keys.

**Phase 4 (Dashboard, started):** a Vite/React SPA (`dashboard/`), built to
`dashboard/dist` and served by the same Worker via Workers Assets — same
origin, so it just calls relative `/api/...` paths. What exists so far is
the Setup page: create the household and people, verify phone numbers,
Plaid Link (real browser-driven linking — this is why it lives in the
dashboard rather than something scriptable via curl), a manual
"add an account" fallback for CSV-only history, and CSV import with
column-mapping auto-detected from the file's own header row. Verified in
a real headless browser (Playwright) end to end: create household → add
person → link/add an account → import a CSV → see the transactions land
correctly categorized.

### Deliberately not built yet

- **Phase 4, the rest of it**: Home (Ready to Assign + envelope list),
  Transactions (list/inline-edit/split), Rules UI (PLAN.md §9) — the
  Setup page above is the only page so far.
- **Full intent parsing** (PLAN.md §5.4, §13 Q13): a reply that arrives
  with nothing open falls through silently rather than answering
  free-form questions like "how much on food this month?" — that's an
  explicitly open product decision, not yet built.
- **Nightly Batch API orchestration**: `submitCategorizationBatch` /
  `parseCategorizationBatchResults` exist and are tested, but nothing yet
  tracks a batch id across cron ticks to drive a bulk backfill job.
- **Adding a member to an existing group chat**: the household group is
  created once from whoever is verified at that moment; a user verified
  afterward isn't auto-added (Sendblue's `/modify-group` endpoint would
  do this — not wired up).
- **Live end-to-end verification**: this build environment holds no real
  Plaid/Sendblue/Anthropic credentials, so nothing here has been run
  against the actual services — only against real D1/crypto and faked
  API clients. Test the Link flow against **Plaid Sandbox** before
  linking a real account (PLAN.md §4.0 — Item slots don't come back).

## Setup

```
npm install
```

### Local development

```
npx wrangler d1 migrations apply curtisclan --local   # creates the local SQLite DB
npm run build:dashboard                                 # builds dashboard/dist once
npm run dev                                             # wrangler dev, http://localhost:8787
```

`GET /health` confirms the Worker is up; `/` serves the dashboard. From
the terminal instead:

```
curl -X POST localhost:8787/api/households -H 'content-type: application/json' \
  -d '{"name":"Curtis Clan"}'
# → seeds the default category taxonomy + one envelope per expense/savings category
```

Webhook/queue/LLM code paths need their secrets (below) to do anything —
without them they fail cleanly with a "missing required secret" error
rather than doing nothing silently.

**Working on the dashboard itself**: `npm --prefix dashboard run dev`
starts Vite's dev server with hot reload, proxying `/api/*` to a
`wrangler dev` you run separately on port 8787 (see `dashboard/vite.config.ts`).
`npm run build:dashboard` from the repo root rebuilds `dashboard/dist` for
`wrangler dev`/`deploy` to pick up — Vite doesn't watch it for you there.

### Tests / typecheck

```
npm test          # vitest run — pure logic + D1-backed tests via miniflare
npm run typecheck # tsc --noEmit
```

## Deploying for real

1. **Create the D1 database and apply migrations:**
   ```
   npx wrangler d1 create curtisclan   # paste the returned database_id into wrangler.jsonc
   npx wrangler d1 migrations apply curtisclan --remote
   ```
2. **Create the two queues** (Workers Paid plan required — PLAN.md §11):
   ```
   npx wrangler queues create curtisclan-transactions
   npx wrangler queues create curtisclan-messages
   ```
3. **Set secrets.** None of these belong in `wrangler.jsonc` or source
   (PLAN.md §10):
   ```
   # 32 random bytes, base64-encoded — encrypts Plaid access tokens at rest
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY

   npx wrangler secret put PLAID_CLIENT_ID
   npx wrangler secret put PLAID_SECRET
   npx wrangler secret put PLAID_ENV        # "sandbox" while testing Link end to end (PLAN.md §4.0),
                                             # "production" once you switch to real Chase/Discover/Amex accounts

   npx wrangler secret put SENDBLUE_API_KEY_ID
   npx wrangler secret put SENDBLUE_API_SECRET_KEY
   npx wrangler secret put SENDBLUE_SIGNING_SECRET   # set when you create the Sendblue webhook, step 5 below

   npx wrangler secret put ANTHROPIC_API_KEY
   ```
4. **Deploy:**
   ```
   npm run deploy   # builds dashboard/dist, then wrangler deploy
   ```
   If you're deploying via Cloudflare's **Workers Builds** Git integration
   rather than running this locally, its configured *Build command*
   (Cloudflare dashboard → your Worker → Settings → Builds) needs to run
   `npm run build:dashboard` before `wrangler deploy` — a plain
   `wrangler deploy` alone won't build the dashboard first, since
   `wrangler` only uploads whatever's already sitting in `dashboard/dist`.
5. **Register webhooks** against your deployed Worker URL:
   - **Plaid**: nothing to register up front — `POST /:householdId/plaid/link-token`
     sets the webhook URL per-item automatically to
     `https://<your-worker>.workers.dev/webhooks/plaid/<householdId>`, scoped
     to the household that started the Link flow.
   - **Sendblue**: in the Sendblue dashboard (or via their webhooks API),
     point your webhook at `https://<your-worker>.workers.dev/webhooks/sendblue`
     and set its signing secret to the same value you put in
     `SENDBLUE_SIGNING_SECRET` above.
   - **Sendblue contact verification** (PLAN.md §5.0): on the free
     shared-line plan, each phone number must text your Sendblue number
     once before the app can message it first. Do that, then call
     `POST /:householdId/users/:userId/verify-phone` with `{"phoneE164": "+1..."}`
     to bind the number — this is the only thing authenticating an
     inbound reply (§10), so nothing sends to or trusts a number that
     hasn't gone through this. **Verify both spouses before the first
     clarification fires**: the group chat is created once, from whoever
     is verified at that moment (`src/messaging/groupChat.ts`) — someone
     verified later isn't automatically added to an already-created group
     (Sendblue has a `/modify-group` endpoint for this; not wired up yet,
     see below).
6. **Build and link accounts against Plaid Sandbox first** (PLAN.md §4.0):
   the 10-Item cap on real accounts doesn't refund on `/item/remove` — get
   the Link flow working end to end in Sandbox, then switch
   `PLAID_ENV` to `production` and link your real Chase/Discover/Amex
   accounts deliberately.

## Project layout

```
migrations/             D1 schema (wrangler d1 migrations)
dashboard/               Vite/React SPA, built to dashboard/dist and served as Workers Assets (see wrangler.jsonc)
src/
  types.ts              Domain types mirroring the schema
  lib/                  Framework-free helpers: money, ids, crypto, CSV, merchant normalization, secrets
  db/                   Household-scoped D1 access — the only code that writes SQL
  import/               Pure CSV-row parsing (no DB)
  envelopes/             Pure envelope-balance arithmetic
  categorization/        Rules engine, merchant-memory matcher, confidence gate, cascade, Claude classifier
  plaid/                 Plaid REST client, webhook JWT verification, /transactions/sync orchestration
  sendblue/               Sendblue REST client + webhook payload types
  messaging/              Household group chat, quiet hours, outbound send, inbound reply resolver + "fix X" corrections
  queue/                  The one queue() consumer, branching on which queue a batch came from
  routes/                 Hono route handlers, one file per resource, plus the two webhook routes
  index.ts                Worker entrypoint: fetch + queue + scheduled
test/                    Mirrors src/ — pure-logic tests, D1-integration tests against real migrated D1,
                          and LLM-calling code tested against a fake Anthropic client
docs/PLAN.md             The full design document this build implements
```
