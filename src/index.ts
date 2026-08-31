import { Hono } from "hono";
import type { Env } from "./types";
import { NotFoundError } from "./db/client";
import { getHousehold } from "./db/households";
import { householdsRoute } from "./routes/households";
import { usersRoute } from "./routes/users";
import { accountsRoute } from "./routes/accounts";
import { categoriesRoute } from "./routes/categories";
import { envelopesRoute } from "./routes/envelopes";
import { transactionsRoute } from "./routes/transactions";
import { rulesRoute } from "./routes/rules";
import { importRoute } from "./routes/importCsv";
import { plaidRoute } from "./routes/plaid";
import { assetsRoute } from "./routes/assets";
import { documentsRoute } from "./routes/documents";
import { maintenanceRoute } from "./routes/maintenance";
import { plaidWebhookRoute } from "./routes/plaidWebhook";
import { sendblueWebhookRoute } from "./routes/sendblueWebhook";
import { handleQueueBatch } from "./queue/consumer";
import { enqueueDailyDigest } from "./messaging/dailyDigest";
import { enqueueNightlyReconciliation } from "./plaid/reconciliation";
import type { MessageQueueMessage, TransactionQueueMessage } from "./lib/queueMessages";

// Must match the second entry in wrangler.jsonc's triggers.crons exactly.
const DAILY_DIGEST_CRON = "0 13 * * *";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT }));

app.route("/api/households", householdsRoute);

// Every resource below is scoped to one household (PLAN §10) — confirm it
// exists once, up front, instead of every handler re-deriving that.
const scoped = new Hono<{ Bindings: Env }>();
scoped.use("/:householdId/*", async (c, next) => {
  await getHousehold(c.env.DB, c.req.param("householdId"));
  await next();
});
scoped.route("/:householdId/users", usersRoute);
scoped.route("/:householdId/accounts", accountsRoute);
scoped.route("/:householdId/categories", categoriesRoute);
scoped.route("/:householdId/envelopes", envelopesRoute);
scoped.route("/:householdId/transactions", transactionsRoute);
scoped.route("/:householdId/rules", rulesRoute);
scoped.route("/:householdId/import", importRoute);
scoped.route("/:householdId/plaid", plaidRoute);
scoped.route("/:householdId/assets", assetsRoute);
scoped.route("/:householdId/documents", documentsRoute);
scoped.route("/:householdId/maintenance", maintenanceRoute);

app.route("/api/households", scoped);

// Webhook endpoints are top-level, not under /api/households — Plaid and
// Sendblue don't speak our household-scoped API shape, and each handler
// resolves (or verifies) the household itself (PLAN §4.1, §10).
app.route("/webhooks/plaid", plaidWebhookRoute);
app.route("/webhooks/sendblue", sendblueWebhookRoute);

export default {
  fetch: app.fetch,

  queue: handleQueueBatch,

  // Two cron schedules, both set in wrangler.jsonc — branch on which one
  // fired rather than one handler per schedule, since ScheduledController
  // only carries the cron expression, not a name.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === DAILY_DIGEST_CRON) {
      const count = await enqueueDailyDigest(env);
      console.log(`daily digest: enqueued for ${count} household(s)`);
      return;
    }
    // Nightly reconciliation (PLAN §4.2: "webhooks... get dropped").
    const count = await enqueueNightlyReconciliation(env);
    console.log(`nightly reconciliation: enqueued sync for ${count} plaid item(s)`);
  },
} satisfies ExportedHandler<Env, TransactionQueueMessage | MessageQueueMessage>;
