import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPostgresUrl, loadEnv, REPO_ROOT } from "./env.ts";
import { openTestDatabase } from "./testing.ts";
import { seedDatabase } from "./seed.ts";
import { TABLE_NAMES } from "./schema.ts";

describe("database configuration", () => {
  it("recognizes postgres URLs", async () => {
    expect(isPostgresUrl("postgres://u:p@host/db")).toBe(true);
    expect(isPostgresUrl("postgresql://u:p@host:6543/db?sslmode=require")).toBe(true);
    expect(isPostgresUrl("pglite:./data/pglite")).toBe(false);
    const env = loadEnv({ DATABASE_URL: "postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres" });
    expect(env.database).toEqual({
      kind: "postgres",
      url: "postgresql://u:p@aws-0.pooler.supabase.com:6543/postgres",
      poolMax: 5,
      caCert: null,
    });
    expect(loadEnv({ DATABASE_URL: "postgres://h/db", DB_POOL_MAX: "2" }).database).toMatchObject({ poolMax: 2 });
  });

  it("uses embedded Postgres in demo mode", async () => {
    expect(loadEnv({ DATABASE_URL: "memory:" }).database).toEqual({ kind: "pglite", dataDir: null });
    expect(loadEnv({ DATABASE_URL: "pglite:./data/x" }).database).toEqual({
      kind: "pglite",
      dataDir: `${REPO_ROOT}/data/x`,
    });
    expect(loadEnv({ DATABASE_URL: "" }).database).toEqual({ kind: "pglite", dataDir: `${REPO_ROOT}/data/pglite` });
  });

  it("rejects old SQLite file URLs with a clear message", async () => {
    expect(() => loadEnv({ DATABASE_URL: "file:./data/dev.db" })).toThrow(/SQLite\) is no longer supported/);
  });

  it("public URLs default to the canonical domains in production and loopback in demo", async () => {
    const demo = loadEnv({ DATABASE_URL: "memory:" });
    expect(demo.urls.api).toBe("http://127.0.0.1:8787");
    expect(demo.shopifyAppUrl).toBe("http://127.0.0.1:8787");
    const custom = loadEnv({ DATABASE_URL: "memory:", SITE_URL: "https://example.test/", MCP_URL: "mcp.example.test" });
    expect(custom.urls.site).toBe("https://example.test");
    expect(custom.urls.mcp).toBe("https://mcp.example.test");
  });
});

describe(".env.example", () => {
  it("boots demo mode when copied verbatim with OFFERLAYER_DEMO=1", async () => {
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const vars = Object.fromEntries([...example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    const env = loadEnv({ ...vars, OFFERLAYER_DEMO: "1", DATABASE_URL: "memory:" });
    const keys = [env.shopperAgentKey, env.sellerAgentKey, env.demoAgentKey, env.museAgentKey];
    expect(keys.every((k) => k.length >= 16)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    const handle = await openTestDatabase(env);
    await expect(seedDatabase(handle)).resolves.toBeDefined();
  });

  it("documents every variable loadEnv reads", async () => {
    const source = readFileSync(join(REPO_ROOT, "packages/db/src/env.ts"), "utf8");
    const read = new Set([...source.matchAll(/(?:get|intEnv)\((?:get, )?"([A-Z0-9_]+)"/g)].map((m) => m[1]));
    read.delete("TOKEN_SECRET"); // legacy: only read to explain the rename
    read.delete("PORT"); // documented in prose next to OFFERLAYER_API_PORT
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const documented = new Set([...example.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const missing = [...read].filter((k) => !documented.has(k));
    expect(missing).toEqual([]);
  });
});

describe("migrations", () => {
  it("create every table with row level security on and no policies", async () => {
    const handle = await openTestDatabase();
    const rows = (await handle.raw(
      "SELECT c.relname AS name, c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'",
    )) as { name: string; rls: boolean }[];
    expect(rows.map((r) => r.name).sort()).toEqual([...TABLE_NAMES].sort());
    for (const r of rows) expect(r.rls, r.name).toBe(true);
    const policies = await handle.raw("SELECT * FROM pg_policies WHERE schemaname = 'public'");
    expect(policies).toEqual([]);
  });

  it("seed is idempotent", async () => {
    const handle = await openTestDatabase();
    await seedDatabase(handle);
    await seedDatabase(handle);
    const offers = await handle.raw("SELECT id FROM offers");
    expect(offers).toEqual([{ id: "off_towel_organic_set" }]);
  });
});

describe("demo mode vs production secrets", () => {
  const db = { DATABASE_URL: "postgres://prod-test.invalid/offerlayer", OFFERLAYER_DEMO: "" };
  const prodSecrets = {
    TOKEN_SIGNING_SECRET: "sig_" + "a".repeat(40),
    ACCESS_TOKEN_ENCRYPTION_KEY: "enc_" + "g".repeat(40),
    PRINCIPAL_HASH_SECRET: "prn_" + "h".repeat(40),
    INTERNAL_API_KEY: "int_" + "b".repeat(28),
    SHOPPER_AGENT_KEY: "agt_" + "d".repeat(28),
    SELLER_AGENT_KEY: "agt_" + "f".repeat(28),
  };

  it("refuses to boot in production mode without explicit secrets", async () => {
    expect(() => loadEnv({ ...db })).toThrow(
      /refusing to boot: .*TOKEN_SIGNING_SECRET, ACCESS_TOKEN_ENCRYPTION_KEY, PRINCIPAL_HASH_SECRET/,
    );
  });

  it("refuses to boot in production mode with a short secret", async () => {
    expect(() => loadEnv({ ...db, ...prodSecrets, TOKEN_SIGNING_SECRET: "x".repeat(20) })).toThrow(/too short/);
  });

  it("refuses to boot when the legacy TOKEN_SECRET is all that is set", async () => {
    const { TOKEN_SIGNING_SECRET: _a, ACCESS_TOKEN_ENCRYPTION_KEY: _b, PRINCIPAL_HASH_SECRET: _c, ...rest } =
      prodSecrets;
    expect(() => loadEnv({ ...db, ...rest, TOKEN_SECRET: "t".repeat(40) })).toThrow(/TOKEN_SECRET is no longer read/);
  });

  it("refuses to boot when two secrets share a value", async () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, PRINCIPAL_HASH_SECRET: prodSecrets.ACCESS_TOKEN_ENCRYPTION_KEY }),
    ).toThrow(/must be different values/);
  });

  it("refuses to boot with a public demo value", async () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, TOKEN_SIGNING_SECRET: "offerlayer_demo_token_signing_secret_v0" }),
    ).toThrow(/public demo value/);
  });

  it("refuses to boot in production mode when Shopify key lacks its secret", async () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, SHOPIFY_API_KEY: "some-key" }),
    ).toThrow(/SHOPIFY_API_SECRET/);
  });

  it("boots in production mode with explicit secrets and never demo defaults", async () => {
    const env = loadEnv({ ...db, ...prodSecrets });
    expect(env.demoMode).toBe(false);
    expect(env.tokenSigningSecret).toBe(prodSecrets.TOKEN_SIGNING_SECRET);
    expect(env.accessTokenEncryptionKey).toBe(prodSecrets.ACCESS_TOKEN_ENCRYPTION_KEY);
    expect(env.principalHashSecret).toBe(prodSecrets.PRINCIPAL_HASH_SECRET);
    expect(env.demoKey).toBe("");
    expect(env.internalApiKey).toBe(prodSecrets.INTERNAL_API_KEY);
    expect(env.sellerAgentKey).toBe(prodSecrets.SELLER_AGENT_KEY);
  });

  it("refuses to boot in production mode without a Postgres URL", async () => {
    expect(() => loadEnv({ ...prodSecrets, OFFERLAYER_DEMO: "", DATABASE_URL: "pglite:./data/x" })).toThrow(
      /DATABASE_URL must be a postgres/,
    );
  });

  it("demo mode still boots with the public demo defaults", async () => {
    const env = loadEnv({ DATABASE_URL: "memory:", OFFERLAYER_DEMO: "1" });
    expect(env.demoMode).toBe(true);
    expect(env.sellerAgentKey).toBe("agt_sell_demo_v0_offerlayer_seed");
  });
});
