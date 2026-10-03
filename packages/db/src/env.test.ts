import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { closeDatabase, openDatabase } from "./client.ts";
import { isPostgresUrl, loadEnv, resolveWritableSqlitePath } from "./env.ts";
import { seedDatabase } from "./seed.ts";

describe("database path on serverless hosts", () => {
  it("treats neon URLs as postgres, not sqlite files", () => {
    expect(isPostgresUrl("postgres://u:p@host/db")).toBe(true);
    expect(isPostgresUrl("postgresql://u:p@host/db?sslmode=require")).toBe(true);
    expect(isPostgresUrl("file:./data/dev.db")).toBe(false);
    const env = loadEnv({ DATABASE_URL: "postgres://u:p@ep-foo.neon.tech/neondb" });
    expect(env.durablePostgres).toBe(true);
    expect(env.databasePath).not.toMatch(/postgres/i);
    expect(env.databasePath === ":memory:" || env.databasePath.includes("offerlayer")).toBe(true);
  });

  it("keeps explicit file: sqlite paths when the directory is writable", () => {
    const path = `${tmpdir()}/ol-env-test.db`;
    const env = loadEnv({ DATABASE_URL: `file:${path}` });
    expect(env.durablePostgres).toBe(false);
    expect(env.databasePath).toBe(path);
  });

  it("demo mode gets distinct signing, encryption, and hashing secrets", () => {
    const env = loadEnv({ OFFERLAYER_DEMO: "1" });
    const secrets = [env.tokenSigningSecret, env.accessTokenEncryptionKey, env.principalHashSecret];
    expect(new Set(secrets).size).toBe(3);
    for (const s of secrets) expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it("APP_URL is the public Shopify origin and never stays localhost", () => {
    const env = loadEnv({
      APP_URL: "https://offerlayer.grok.me",
      SHOPIFY_APP_URL: "http://localhost:3000",
      PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      VERCEL: "1",
    });
    expect(env.publicBaseUrl).toBe("https://offerlayer.grok.me");
    expect(env.shopifyAppUrl).toBe("https://offerlayer.grok.me");
    expect(env.shopifyAppUrl).not.toMatch(/localhost/);
  });

  it("writable sqlite path never returns a postgres URL", () => {
    expect(isPostgresUrl(resolveWritableSqlitePath("postgres://x"))).toBe(false);
  });

  it("opens sqlite and seeds even when DATABASE_URL is postgres", () => {
    const env = loadEnv({ DATABASE_URL: "postgres://u:p@ep-foo.neon.tech/neondb" });
    const handle = openDatabase(env);
    seedDatabase(handle);
    const row = handle.sqlite.prepare("select id from offers where id = ?").get("off_towel_organic_set") as {
      id: string;
    };
    expect(row.id).toBe("off_towel_organic_set");
    closeDatabase(handle);
  });
});

describe("demo mode vs production secrets", () => {
  const db = { DATABASE_URL: `file:${tmpdir()}/ol-env-secrets-test.db`, OFFERLAYER_DEMO: "" };
  const prodSecrets = {
    TOKEN_SIGNING_SECRET: "sig_" + "a".repeat(40),
    ACCESS_TOKEN_ENCRYPTION_KEY: "enc_" + "g".repeat(40),
    PRINCIPAL_HASH_SECRET: "prn_" + "h".repeat(40),
    INTERNAL_API_KEY: "int_" + "b".repeat(28),
    DEMO_AGENT_KEY: "agt_" + "d".repeat(28),
    MUSE_AGENT_KEY: "agt_" + "e".repeat(28),
    SELLER_AGENT_KEY: "agt_" + "f".repeat(28),
  };

  it("refuses to boot in production mode without explicit secrets", () => {
    expect(() => loadEnv({ ...db })).toThrow(
      /refusing to boot: .*TOKEN_SIGNING_SECRET, ACCESS_TOKEN_ENCRYPTION_KEY, PRINCIPAL_HASH_SECRET/,
    );
  });

  it("refuses to boot in production mode with a short secret", () => {
    expect(() => loadEnv({ ...db, ...prodSecrets, TOKEN_SIGNING_SECRET: "x".repeat(20) })).toThrow(/too short/);
  });

  it("refuses to boot when the legacy TOKEN_SECRET is all that is set", () => {
    const { TOKEN_SIGNING_SECRET: _a, ACCESS_TOKEN_ENCRYPTION_KEY: _b, PRINCIPAL_HASH_SECRET: _c, ...rest } =
      prodSecrets;
    expect(() => loadEnv({ ...db, ...rest, TOKEN_SECRET: "t".repeat(40) })).toThrow(/TOKEN_SECRET is no longer read/);
  });

  it("refuses to boot when two secrets share a value", () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, PRINCIPAL_HASH_SECRET: prodSecrets.ACCESS_TOKEN_ENCRYPTION_KEY }),
    ).toThrow(/must be different values/);
  });

  it("refuses to boot with a public demo value", () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, TOKEN_SIGNING_SECRET: "offerlayer_demo_token_signing_secret_v0" }),
    ).toThrow(/public demo value/);
  });

  it("refuses to boot in production mode when Shopify key lacks its secret", () => {
    expect(() =>
      loadEnv({ ...db, ...prodSecrets, SHOPIFY_API_KEY: "some-key" }),
    ).toThrow(/SHOPIFY_API_SECRET/);
  });

  it("boots in production mode with explicit secrets and never demo defaults", () => {
    const env = loadEnv({ ...db, ...prodSecrets });
    expect(env.demoMode).toBe(false);
    expect(env.tokenSigningSecret).toBe(prodSecrets.TOKEN_SIGNING_SECRET);
    expect(env.accessTokenEncryptionKey).toBe(prodSecrets.ACCESS_TOKEN_ENCRYPTION_KEY);
    expect(env.principalHashSecret).toBe(prodSecrets.PRINCIPAL_HASH_SECRET);
    expect(env.demoKey).toBe("");
    expect(env.internalApiKey).toBe(prodSecrets.INTERNAL_API_KEY);
    expect(env.sellerAgentKey).toBe(prodSecrets.SELLER_AGENT_KEY);
  });

  it("demo mode still boots with the public demo defaults", () => {
    const env = loadEnv({ DATABASE_URL: db.DATABASE_URL, OFFERLAYER_DEMO: "1" });
    expect(env.demoMode).toBe(true);
    expect(env.sellerAgentKey).toBe("agt_sell_demo_v0_offerlayer_seed");
  });
});
