# Home Base

Self-owned budgeting app on Cloudflare Workers, fed by Plaid, with an
iMessage loop that asks what a charge was and understands the answer in
plain English. Full design in [`docs/PLAN.md`](docs/PLAN.md).

Thank you for using! Please email nathan14curtis@gmail.com with suggestions for UX changes and improvements.

## Setup

```
npm install
```

### Local development

```
npx wrangler d1 migrations apply curtisclan --local   # creates the local SQLite DB
npm run dev                                             # wrangler dev, http://localhost:8787
```

`npm run dev` builds `dashboard/dist` for you automatically (via
`wrangler.jsonc`'s `build.command`) before starting the dev server.
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
   npx wrangler secret put SENDBLUE_FROM_NUMBER      # your Sendblue-assigned number — required by their API on every send
   npx wrangler secret put SENDBLUE_SIGNING_SECRET   # set when you create the Sendblue webhook, step 5 below

   npx wrangler secret put ANTHROPIC_API_KEY
   ```
4. **Deploy:**
   ```
   npm run deploy
   ```
   `wrangler.jsonc`'s `build.command` (`npm run build:dashboard`) runs
   automatically as part of `wrangler dev`/`wrangler deploy` — including
   inside Cloudflare's **Workers Builds** Git integration, since that also
   just runs `wrangler deploy` under the hood. No separate "Build command"
   setting needed in the Cloudflare dashboard.
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
