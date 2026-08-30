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

**112 tests**, `vitest run` green, `tsc --noEmit` clean. Pure logic is
tested directly (including a real generated ES256 keypair signing/
verifying an actual JWT — not a mocked crypto call); D1-backed code runs
against a real migrated database via `@cloudflare/vitest-pool-workers`
(miniflare); the LLM-calling code is tested against a fake `Anthropic`
client double, since this environment holds no live API keys.

### Deliberately not built yet

- **Phase 4 (Dashboard):** the React/Vite SPA on Workers Assets. The API
  it needs already exists.
- **Full intent parsing** (PLAN.md §5.4, §13 Q13): a reply that arrives
  with nothing open falls through silently rather than answering
  free-form questions like "how much on food this month?" — that's an
  explicitly open product decision, not yet built.
- **Nightly Batch API orchestration**: `submitCategorizationBatch` /
  `parseCategorizationBatchResults` exist and are tested, but nothing yet
  tracks a batch id across cron ticks to drive a bulk backfill job.
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
npm run dev                                             # wrangler dev, http://localhost:8787
```

`GET /health` confirms the Worker is up. From there:

```
curl -X POST localhost:8787/api/households -H 'content-type: application/json' \
  -d '{"name":"Curtis Clan"}'
# → seeds the default category taxonomy + one envelope per expense/savings category
```

Webhook/queue/LLM code paths need their secrets (below) to do anything —
without them they fail cleanly with a "missing required secret" error
rather than doing nothing silently.

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
   npm run deploy
   ```
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
     hasn't gone through this.
6. **Build and link accounts against Plaid Sandbox first** (PLAN.md §4.0):
   the 10-Item cap on real accounts doesn't refund on `/item/remove` — get
   the Link flow working end to end in Sandbox, then switch
   `PLAID_ENV` to `production` and link your real Chase/Discover/Amex
   accounts deliberately.

## Project layout

```
migrations/             D1 schema (wrangler d1 migrations)
src/
  types.ts              Domain types mirroring the schema
  lib/                  Framework-free helpers: money, ids, crypto, CSV, merchant normalization, secrets
  db/                   Household-scoped D1 access — the only code that writes SQL
  import/               Pure CSV-row parsing (no DB)
  envelopes/             Pure envelope-balance arithmetic
  categorization/        Rules engine, merchant-memory matcher, confidence gate, cascade, Claude classifier
  plaid/                 Plaid REST client, webhook JWT verification, /transactions/sync orchestration
  sendblue/               Sendblue REST client + webhook payload types
  messaging/              Quiet hours, outbound send, inbound reply resolver + "fix X" corrections
  queue/                  The one queue() consumer, branching on which queue a batch came from
  routes/                 Hono route handlers, one file per resource, plus the two webhook routes
  index.ts                Worker entrypoint: fetch + queue + scheduled
test/                    Mirrors src/ — pure-logic tests, D1-integration tests against real migrated D1,
                          and LLM-calling code tested against a fake Anthropic client
docs/PLAN.md             The full design document this build implements
```
