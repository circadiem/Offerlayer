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

  it("TOKEN_SECRET falls back to a long default", () => {
    const env = loadEnv({ TOKEN_SECRET: "short" });
    expect(env.tokenSecret.length).toBeGreaterThanOrEqual(16);
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
