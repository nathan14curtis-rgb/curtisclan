import { applyD1Migrations, env } from "cloudflare:test";

// Runs once before the test file's own module code, against the
// in-memory D1 instance miniflare provisions for this test run — so every
// test in test/db/*.test.ts sees the real schema from migrations/*.sql.
await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS);
