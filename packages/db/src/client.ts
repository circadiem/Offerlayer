import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { schema } from "./schema.ts";
import { loadEnv, type OfferlayerEnv } from "./env.ts";
import { pgSslConfig } from "./ssl.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, "../migrations");

type Schema = typeof schema;
/** The Drizzle client. Same API on node-postgres (production) and PGlite (tests, local demo). */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Transaction = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything queries can run on: the client or an open transaction. */
export type Queryable = Database | Transaction;

export interface DbHandle {
  db: Database;
  env: OfferlayerEnv;
  kind: "postgres" | "pglite";
  /** Raw parameterized SQL, for scripts and tests. Returns rows. */
  raw: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
}

/**
 * Open the database named by env.database.
 *
 * - Postgres: a node-postgres pool. Queries never use named prepared
 *   statements, so this works through Supabase's transaction-mode pooler
 *   (port 6543). Migrations are NOT run here; `pnpm db:migrate` runs them at
 *   build time, over a direct connection when DATABASE_URL_DIRECT is set.
 * - PGlite: an embedded Postgres, migrated on open.
 */
export async function openDatabase(env: OfferlayerEnv = loadEnv()): Promise<DbHandle> {
  if (env.database.kind === "postgres") {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.default.Pool({
      connectionString: env.database.url,
      max: env.database.poolMax,
      idleTimeoutMillis: 10_000,
      ssl: pgSslConfig(env.database.url, env.database.caCert),
    });
    const db = drizzle(pool, { schema }) as unknown as Database;
    return {
      db,
      env,
      kind: "postgres",
      raw: async (text, params) => (await pool.query(text, params)).rows,
      close: () => pool.end(),
    };
  }

  // The bundled server (Vercel) ships neither the migrations nor PGlite's
  // WASM assets, and a failed PGlite start kills the process. Fail clearly
  // instead: a deployed host needs Postgres, even in demo mode.
  if (!existsSync(join(MIGRATIONS_DIR, "meta/_journal.json"))) {
    throw new Error(
      "[offerlayer] the embedded database (PGlite) is not available in this build. " +
        "Set DATABASE_URL to a postgres:// URL.",
    );
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dataDir = env.database.dataDir;
  if (dataDir) mkdirSync(dirname(dataDir), { recursive: true });
  const client = new PGlite(dataDir ?? undefined);
  const handle = await pgliteHandle(client, env);
  await migratePglite(handle);
  return handle;
}

type PGliteClient = import("@electric-sql/pglite").PGlite;

export async function pgliteHandle(client: PGliteClient, env: OfferlayerEnv): Promise<DbHandle> {
  const { drizzle } = await import("drizzle-orm/pglite");
  const db = drizzle(client, { schema }) as unknown as Database;
  return {
    db,
    env,
    kind: "pglite",
    raw: async (text, params) => (await client.query<Record<string, unknown>>(text, params)).rows,
    close: () => client.close(),
  };
}

export async function migratePglite(handle: DbHandle): Promise<void> {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_DIR });
}

/** Apply pending migrations to a Postgres URL (build step; see scripts/db-migrate.ts). */
export async function migratePostgres(url: string, caCert?: string | null): Promise<void> {
  const pg = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.default.Pool({ connectionString: url, max: 1, ssl: pgSslConfig(url, caCert) });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await pool.end();
  }
}

export async function closeDatabase(handle: DbHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // already closed
  }
}
