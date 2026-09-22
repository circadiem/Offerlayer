import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema.ts";
import { loadEnv, resolveWritableSqlitePath, type OfferlayerEnv } from "./env.ts";
import { MIGRATION_SQL } from "./migration-sql.ts";

export type SqliteDatabase = Database.Database;
export type DatabaseClient = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  sqlite: Database.Database;
  db: DatabaseClient;
  env: OfferlayerEnv;
  path: string;
}

function openSqliteAt(path: string): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  try {
    sqlite.pragma("journal_mode = WAL");
  } catch {
    // :memory: or restricted FS
  }
  return sqlite;
}

export function openSqlite(path: string): Database.Database {
  const attempts = [path, resolveWritableSqlitePath(), ":memory:"];
  const seen = new Set<string>();
  let lastErr: unknown;
  for (const candidate of attempts) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return openSqliteAt(candidate);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Failed to open sqlite");
}

export function migrate(sqlite: Database.Database): void {
  sqlite.exec(MIGRATION_SQL);
  const agentCols = sqlite.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
  if (!agentCols.some((c) => c.name === "role")) {
    sqlite.exec("ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'shopper'");
  }
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS seller_links (
  id TEXT PRIMARY KEY,
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  shop_domain TEXT,
  status TEXT NOT NULL,
  install_url TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  merchant_id TEXT REFERENCES merchants(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_grants (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, seller_agent_id)
);

CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  allow_json TEXT NOT NULL,
  caps_json TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  card_text TEXT NOT NULL,
  human_confirmed_at TEXT,
  revoked_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mandates_seller_merchant ON mandates(seller_agent_id, merchant_id, status);
`);
  const offerCols = sqlite.prepare("PRAGMA table_info(offers)").all() as { name: string }[];
  if (!offerCols.some((c) => c.name === "mandate_id")) {
    sqlite.exec("ALTER TABLE offers ADD COLUMN mandate_id TEXT");
  }
  const merchantCols = sqlite.prepare("PRAGMA table_info(merchants)").all() as { name: string }[];
  if (!merchantCols.some((c) => c.name === "catalog_json")) {
    sqlite.exec("ALTER TABLE merchants ADD COLUMN catalog_json TEXT");
  }
}

export function openDatabase(env: OfferlayerEnv = loadEnv()): DbHandle {
  const sqlite = openSqlite(env.databasePath);
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, env, path: env.databasePath };
}

export function closeDatabase(handle: DbHandle): void {
  try {
    handle.sqlite.close();
  } catch {
    // already closed
  }
}
