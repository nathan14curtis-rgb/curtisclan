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

app.route("/api/households", scoped);

export default app;

// Queue consumer and scheduled() cron handler are Phase 1/1-reconciliation
// work (PLAN §4.2, §12) — not added until there's a real Plaid webhook and
// /transactions/sync cursor to drive them, so an empty handler doesn't
// silently "succeed" against nothing.
