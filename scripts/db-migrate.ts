/**
 * Apply pending Drizzle migrations (packages/db/migrations) to Postgres.
 * Runs as part of `pnpm build`, so every deploy migrates before it serves.
 *
 * Uses DATABASE_URL_DIRECT when set: Supabase recommends a direct (or
 * session-mode, port 5432) connection for migrations rather than the
 * transaction pooler the app uses at runtime.
 *
 * With no Postgres URL (local builds, tests) there is nothing to do: the
 * embedded PGlite database migrates itself when opened.
 */
import { isPostgresUrl, migratePostgres } from "@offerlayer/db";

const url = (process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL || "").trim();
if (!isPostgresUrl(url)) {
  console.log("[db:migrate] no Postgres DATABASE_URL; skipping (PGlite migrates on open).");
  process.exit(0);
}
const started = Date.now();
await migratePostgres(url);
console.log(`[db:migrate] migrations applied in ${Date.now() - started}ms`);
