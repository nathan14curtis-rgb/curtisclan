# Curtis Clan

Self-owned budgeting app on Cloudflare Workers, fed by Plaid, with an
iMessage loop that asks what a charge was and understands the answer in
plain English. Full design in [`docs/PLAN.md`](docs/PLAN.md).

## What's built (Phase 0 — Foundations)

This repo currently implements PLAN.md's Phase 0, plus the parts of later
phases that are pure logic and don't need a live Plaid, Sendblue, or
Anthropic account to build and verify:

- **Worker + Hono + D1**, with `wrangler.jsonc` declaring the D1, Queues,
  and cron bindings later phases will use.
- **Full data model** (`migrations/0001_init.sql`) per PLAN.md §3: household,
  user, account, category, envelope, allocation, transaction,
  transaction_classification, clarification, inbound_message,
  merchant_memory, rule.
- **Household-scoped data access layer** (`src/db/*.ts`) — every read/write
  takes `householdId` as a required argument and bakes it into the SQL
  itself (PLAN.md §10).
- **Default category taxonomy** seeded on household creation
  (`src/lib/defaultCategories.ts`), with one envelope automatically created
  per expense/savings category (PLAN.md §3, §8).
- **CSV import** (`src/import/csvImport.ts`, `src/db/csvImport.ts`) for
  bringing in Simplifi (or any similarly-shaped) transaction history, with
  category-name matching and idempotent re-import.
- **Envelope ledger** (`src/envelopes/ledger.ts`, `src/db/envelopes.ts`) —
  derived balances, negative-balance carryover, first-class money moves
  between envelopes, and the Ready-to-Assign credit-card correction from
  PLAN.md §8.3.1.
- **Categorization cascade, layers 1–2 fully wired** (`src/categorization/`):
  the rules engine and merchant-memory fast path. Layer 3 (the LLM call)
  is a fixed interface with an intentionally unimplemented stub — see
  below — and the confidence-combination logic that will gate its
  auto-apply decision is built and tested independently of it.
- **REST API** (`src/routes/*.ts`) covering all of the above: households,
  users (with phone verification), accounts, categories, envelopes,
  transactions (list/get/categorize/split), rules, CSV import.
- **67 tests**, `vitest run` green, `tsc --noEmit` clean. Pure logic
  (money, envelope arithmetic, rules matching, confidence gating, CSV
  parsing, merchant normalization) is tested directly; D1-backed code is
  tested against a real migrated database via
  `@cloudflare/vitest-pool-workers` (miniflare), not mocks.

### Deliberately not built yet

Phase 0's boundary is real external accounts: this environment doesn't
hold a Plaid, Sendblue, or Anthropic API key, so wiring those up now would
mean shipping integration code nobody has run against the real service —
untested code claiming to work. Per PLAN.md §12:

- **Phase 1 (Ingest):** Plaid Link flow, `/transactions/sync` + webhook
  Queue consumer, access-token encryption is implemented
  (`src/lib/crypto.ts`, `src/db/accounts.ts`) but has nothing to encrypt
  yet, pending→posted transition handling, nightly reconciliation cron.
- **Phase 2 (Categorization layer 3):** `src/categorization/llm.ts`'s
  `UnimplementedLlmClassifier` needs a real Claude Haiku 4.5 call with the
  taxonomy in a cached prompt prefix, Sonnet 5 escalation, and the Batch
  API for nightly bulk runs. The cascade (`src/categorization/cascade.ts`)
  and confidence gate (`src/categorization/confidence.ts`) already call
  through a fixed `LlmClassifier` interface, so this is a drop-in.
- **Phase 3 (iMessage loop):** Sendblue send/inbound webhooks, phone
  verification handshake, the batch reply resolver (§5.2), quiet hours,
  timeouts.
- **Phase 4 (Dashboard):** the React/Vite SPA on Workers Assets. The API
  it needs already exists.

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

### Tests / typecheck

```
npm test          # vitest run — pure logic + D1-backed tests via miniflare
npm run typecheck # tsc --noEmit
```

### Deploying for real

1. `npx wrangler d1 create curtisclan` and paste the returned `database_id`
   into `wrangler.jsonc`.
2. `npx wrangler queues create curtisclan-transactions` (Workers Paid plan
   required — see PLAN.md §11).
3. `npx wrangler d1 migrations apply curtisclan --remote`.
4. `npx wrangler secret put <NAME>` for each secret Phase 1+ needs
   (`TOKEN_ENCRYPTION_KEY`, then `PLAID_CLIENT_ID` / `PLAID_SECRET`,
   `SENDBLUE_API_KEY` / `SENDBLUE_API_SECRET`, `ANTHROPIC_API_KEY` as those
   phases land) — never in `wrangler.jsonc` or source (PLAN.md §10).
5. `npm run deploy`.

## Project layout

```
migrations/            D1 schema (wrangler d1 migrations)
src/
  types.ts             Domain types mirroring the schema
  lib/                 Framework-free helpers: money, ids, crypto, CSV, merchant normalization
  db/                  Household-scoped D1 access — the only code that writes SQL
  import/              Pure CSV-row parsing (no DB)
  envelopes/            Pure envelope-balance arithmetic
  categorization/       Rules engine, merchant-memory matcher, confidence gate, cascade, LLM interface
  routes/               Hono route handlers, one file per resource
  index.ts              Worker entrypoint
test/                   Mirrors src/ — pure-logic unit tests plus db.integration.test.ts against real D1
docs/PLAN.md            The full design document this build implements
```
