import { writeFileSync } from "node:fs";
import type { DbHandle } from "./client.ts";
import { isPostgresUrl } from "./env.ts";

const STORE_ID = "main";
const DDL = `CREATE TABLE IF NOT EXISTS offerlayer_store (
  id TEXT PRIMARY KEY,
  sqlite_bytes BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

type PgPool = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

let pool: PgPool | null | undefined;

function postgresUrl(): string | undefined {
  const raw = process.env.DATABASE_URL?.trim();
  if (raw && isPostgresUrl(raw)) return raw;
  return undefined;
}

async function getPool(): Promise<PgPool | null> {
  if (pool !== undefined) return pool;
  const url = postgresUrl();
  if (!url) {
    pool = null;
    return null;
  }
  try {
    const pg = await import("pg");
    const created = new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 15_000 });
    pool = created as unknown as PgPool;
    return pool;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "pg_pool_failed", error: String(err) })}\n`,
    );
    pool = null;
    return null;
  }
}

export async function restoreSqliteFile(destPath: string): Promise<boolean> {
  if (destPath === ":memory:") return false;
  const p = await getPool();
  if (!p) return false;
  try {
    await p.query(DDL);
    const res = await p.query("SELECT sqlite_bytes FROM offerlayer_store WHERE id = $1", [STORE_ID]);
    const row = res.rows[0] as { sqlite_bytes?: Buffer } | undefined;
    const bytes = row?.sqlite_bytes as unknown;
    if (!bytes) return false;
    const buf = Buffer.isBuffer(bytes)
      ? bytes
      : bytes instanceof Uint8Array
        ? Buffer.from(bytes)
        : null;
    if (!buf || buf.length < 100) return false;
    writeFileSync(destPath, buf);
    return true;
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "sqlite_restore_failed", error: String(err) })}\n`,
    );
    return false;
  }
}

export async function persistSqliteHandle(handle: DbHandle): Promise<void> {
  const p = await getPool();
  if (!p) return;
  try {
    const buf = handle.sqlite.serialize();
    await p.query(DDL);
    await p.query(
      `INSERT INTO offerlayer_store (id, sqlite_bytes, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (id) DO UPDATE SET sqlite_bytes = EXCLUDED.sqlite_bytes, updated_at = now()`,
      [STORE_ID, buf],
    );
  } catch (err) {
    process.stderr.write(
      `${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "sqlite_persist_failed", error: String(err) })}\n`,
    );
  }
}
