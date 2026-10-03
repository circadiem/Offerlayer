import { describe, expect, it } from "vitest";
import { CANONICAL_URLS, loadEnv } from "@offerlayer/db";
import { requestPublicOrigin } from "./origin.ts";

function headers(map: Record<string, string>) {
  return { header: (n: string) => map[n.toLowerCase()] };
}

const PROD = {
  OFFERLAYER_DEMO: "",
  DATABASE_URL: "postgres://prod-test.invalid/offerlayer",
  TOKEN_SIGNING_SECRET: "s".repeat(40),
  ACCESS_TOKEN_ENCRYPTION_KEY: "e".repeat(40),
  PRINCIPAL_HASH_SECRET: "p".repeat(40),
  INTERNAL_API_KEY: "i".repeat(20),
  SHOPPER_AGENT_KEY: "d".repeat(20),
  SELLER_AGENT_KEY: "k".repeat(20),
};

describe("requestPublicOrigin", () => {
  it("in production always returns the configured API URL, whatever the Host", async () => {
    const env = loadEnv(PROD);
    expect(env.urls).toMatchObject(CANONICAL_URLS);
    for (const host of ["offerlayer-abc123.vercel.app", "evil.example.com", "127.0.0.1:8787"]) {
      expect(requestPublicOrigin(headers({ host, "x-forwarded-host": host }), env)).toBe(
        "https://api.offerlayer.io",
      );
    }
  });

  it("honors API_URL overrides for staging", async () => {
    const env = loadEnv({ ...PROD, API_URL: "staging-api.offerlayer.io/" });
    expect(requestPublicOrigin(headers({ host: "x.vercel.app" }), env)).toBe("https://staging-api.offerlayer.io");
    expect(env.shopifyAppUrl).toBe("https://staging-api.offerlayer.io");
  });

  it("in demo mode follows a public Host and strips stray ports", async () => {
    const env = loadEnv({ DATABASE_URL: "memory:" });
    expect(
      requestPublicOrigin(headers({ "x-forwarded-host": "demo.example.com", "x-forwarded-proto": "https" }), env),
    ).toBe("https://demo.example.com");
    expect(requestPublicOrigin(headers({ host: "demo.example.com:3000" }), env)).toBe("https://demo.example.com");
  });

  it("in demo mode on loopback uses the local API URL", async () => {
    const env = loadEnv({ DATABASE_URL: "memory:" });
    expect(requestPublicOrigin(headers({ host: "127.0.0.1:8787" }), env)).toBe("http://127.0.0.1:8787");
  });
});
