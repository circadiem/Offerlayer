import { isPostgresUrl, loadEnv, type OfferlayerEnv } from "./env.ts";
import { migratePglite, migratePostgres, pgliteHandle, type Database, type DbHandle } from "./client.ts";
import { TABLE_NAMES } from "./schema.ts";

type PGliteClient = import("@electric-sql/pglite").PGlite;

/**
 * One migrated in-memory PGlite per test process. Starting PGlite takes
 * seconds, truncating takes milliseconds, so each test gets a clean database
 * by truncating the shared one.
 */
let shared: Promise<PGliteClient> | null = null;

async function sharedClient(env: OfferlayerEnv): Promise<PGliteClient> {
  shared ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await migratePglite(await pgliteHandle(client, env));
    return client;
  })();
  return shared;
}

/**
 * TEST_DATABASE_URL=postgres://… runs the suite against a real Postgres
 * (node-postgres, the production driver) instead of PGlite. The database is
 * migrated once and truncated before each test, so point it at a throwaway
 * database.
 */
let sharedPg: Promise<{ db: Database; raw: DbHandle["raw"] }> | null = null;

async function sharedPostgres(url: string) {
  sharedPg ??= (async () => {
    await migratePostgres(url);
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { schema } = await import("./schema.ts");
    const pool = new pg.default.Pool({ connectionString: url, max: 5 });
    return {
      db: drizzle(pool, { schema }) as unknown as Database,
      raw: async (text: string, params?: unknown[]) => (await pool.query(text, params)).rows,
    };
  })();
  return sharedPg;
}

/**
 * An empty, migrated database for a test. `close()` is a no-op so tests can
 * keep calling closeDatabase(); the next openTestDatabase() wipes the data.
 */
export async function openTestDatabase(env: OfferlayerEnv = loadEnv({ DATABASE_URL: "memory:" })): Promise<DbHandle> {
  const pgUrl = process.env.TEST_DATABASE_URL?.trim();
  if (pgUrl && isPostgresUrl(pgUrl)) {
    const { db, raw } = await sharedPostgres(pgUrl);
    await raw(`TRUNCATE ${TABLE_NAMES.map((t) => `"${t}"`).join(", ")} CASCADE`);
    return { db, env, kind: "postgres", raw, close: async () => {} };
  }
  const client = await sharedClient(env);
  await client.exec(`TRUNCATE ${TABLE_NAMES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  const handle = await pgliteHandle(client, env);
  return { ...handle, close: async () => {} };
}

/** The same database seen through a different env (e.g. rotated secrets). */
export function withEnv(handle: DbHandle, env: OfferlayerEnv): DbHandle {
  return { ...handle, env };
}
