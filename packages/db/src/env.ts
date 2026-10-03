import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../../..");

function loadDotEnv(): void {
  const path = join(REPO_ROOT, ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export interface OfferlayerEnv {
  port: number;
  database: DatabaseConfig;
  /** Signs checkout tokens (HMAC). */
  tokenSigningSecret: string;
  /** AES-256-GCM key material for stored Shopify access tokens. */
  accessTokenEncryptionKey: string;
  /** HMAC key for shopper identifiers (principal_ref, order emails). */
  principalHashSecret: string;
  /** Old values still accepted for verify/decrypt during a rotation (docs/SECRETS.md). */
  tokenSigningSecretPrevious: string;
  accessTokenEncryptionKeyPrevious: string;
  demoKey: string;
  shopifyApiKey: string;
  shopifyApiSecret: string;
  /** Where the Shopify app is served (OAuth start, redirect). */
  shopifyAppUrl: string;
  shopifyScopes: string;
  internalApiKey: string;
  /** Bootstrap shopper-agent key (until self-serve keys ship). */
  shopperAgentKey: string;
  /** Demo mode only; empty in production. */
  demoAgentKey: string;
  /** Demo mode only; empty in production. */
  museAgentKey: string;
  sellerAgentKey: string;
  urls: PublicUrls;
  /** Bearer Vercel Cron sends to /v1/internal/jobs/*; empty = internal key only. */
  cronSecret: string;
  /** True only when OFFERLAYER_DEMO=1. Demo-only defaults apply; never true in production. */
  demoMode: boolean;
  limits: CheckoutLimits;
}

/**
 * The canonical public hosts. Everything handed to Shopify (OAuth redirect,
 * webhook URLs) and to agents (install links, docs) is built from these, never
 * from a request's Host header.
 */
export interface PublicUrls {
  /** Marketing site and docs. */
  site: string;
  /** Public API and webhooks. */
  api: string;
  /** Remote MCP server. */
  mcp: string;
  /** Shopify app URL (defaults to the API host, which serves /auth/*). */
  shopifyApp: string;
}

export const CANONICAL_URLS = {
  site: "https://www.offerlayer.io",
  api: "https://api.offerlayer.io",
  mcp: "https://mcp.offerlayer.io",
} as const;

function cleanUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, "");
  if (!v) return "";
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/**
 * SITE_URL, API_URL, MCP_URL, SHOPIFY_APP_URL override the canonical hosts
 * (e.g. for a staging deploy). Demo mode defaults to the local dev servers.
 */
function resolveUrls(get: (key: string, fallback?: string) => string, demoMode: boolean): PublicUrls {
  const local = {
    site: "http://127.0.0.1:8080",
    api: `http://127.0.0.1:${get("OFFERLAYER_API_PORT") || "8787"}`,
    mcp: `http://127.0.0.1:${get("OFFERLAYER_API_PORT") || "8787"}/mcp`,
  };
  const base = demoMode ? local : CANONICAL_URLS;
  const api = cleanUrl(get("API_URL")) || base.api;
  return {
    site: cleanUrl(get("SITE_URL")) || base.site,
    api,
    mcp: cleanUrl(get("MCP_URL")) || base.mcp,
    shopifyApp: cleanUrl(get("SHOPIFY_APP_URL")) || api,
  };
}

export interface CheckoutLimits {
  /** Lifetime of a checkout token and its Shopify discount code. */
  checkoutTtlSeconds: number;
  /** Default per-agent-key checkout rate limits (overridable per key). */
  checkoutsPerMinute: number;
  checkoutsPerDay: number;
  /** Checkouts without a principal_ref, per offer per UTC day. */
  anonCheckoutsPerOfferPerDay: number;
  /** Unused, unexpired checkout tokens allowed per offer at once. */
  maxOutstandingPerOffer: number;
}

/**
 * Demo-only defaults. These values are PUBLIC (they appear in the README and
 * the connector brief) and must never authenticate a non-demo host.
 * loadEnv() refuses to use them unless OFFERLAYER_DEMO=1.
 */
export const SEED_DEFAULTS = {
  tokenSigningSecret: "offerlayer_demo_token_signing_secret_v0",
  accessTokenEncryptionKey: "offerlayer_demo_access_token_encryption_v0",
  principalHashSecret: "offerlayer_demo_principal_hash_secret_v0",
  demoKey: "offerlayer_demo_v0",
  shopifyApiSecret: "offerlayer_shopify_secret_v0",
  internalApiKey: "offerlayer_internal_v0",
  shopperAgentKey: "agt_live_shopper_v0_offerlayer_seed",
  demoAgentKey: "agt_live_demo_v0_offerlayer_seed",
  museAgentKey: "agt_live_muse_v0_offerlayer_seed",
  sellerAgentKey: "agt_sell_demo_v0_offerlayer_seed",
} as const;

export function isPostgresUrl(url: string): boolean {
  return /^(postgres|postgresql)(\+[^:]*)?:\/\//i.test(url.trim());
}

export type DatabaseConfig =
  | { kind: "postgres"; url: string; poolMax: number; caCert: string | null }
  /** dataDir null = in memory. */
  | { kind: "pglite"; dataDir: string | null };

/**
 * DATABASE_URL forms:
 * - postgres://… or postgresql://…  real Postgres (required in production)
 * - pglite:<dir>                     embedded Postgres persisted to <dir>
 * - memory:                          embedded Postgres in memory
 * - unset                            demo mode only: pglite:./data/pglite
 */
function resolveDatabase(raw: string, demoMode: boolean, poolMax: number, caCert: string): DatabaseConfig {
  const url = raw.trim();
  if (isPostgresUrl(url)) return { kind: "postgres", url, poolMax, caCert: caCert.trim() || null };
  if (!demoMode) {
    throw new Error(
      "[offerlayer] refusing to boot: DATABASE_URL must be a postgres:// URL outside demo mode " +
        "(an embedded database on a serverless host loses data).",
    );
  }
  if (!url) return { kind: "pglite", dataDir: resolve(REPO_ROOT, "data/pglite") };
  if (url === "memory:") return { kind: "pglite", dataDir: null };
  if (url.startsWith("pglite:")) {
    const dir = url.slice("pglite:".length);
    return { kind: "pglite", dataDir: isAbsolute(dir) ? dir : resolve(REPO_ROOT, dir) };
  }
  if (url.startsWith("file:")) {
    throw new Error(
      "[offerlayer] DATABASE_URL=file:… (SQLite) is no longer supported. Use pglite:<dir>, memory:, or postgres://.",
    );
  }
  throw new Error(`[offerlayer] unrecognized DATABASE_URL: ${url.slice(0, 12)}…`);
}

function intEnv(get: (key: string, fallback?: string) => string, key: string, fallback: number): number {
  const raw = get(key, "");
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`[offerlayer] refusing to boot: ${key} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function loadEnv(overrides: Partial<Record<string, string>> = {}): OfferlayerEnv {
  // An empty value counts as unset (a copied .env.example is full of
  // `KEY=` lines). An override, even "", takes precedence over process.env.
  const get = (key: string, fallback = ""): string => {
    const value = key in overrides ? overrides[key] : process.env[key];
    return value === undefined || value === "" ? fallback : value;
  };

  const demoMode = get("OFFERLAYER_DEMO", "") === "1";

  // Fail closed: the SEED_DEFAULTS values are public (README, connector
  // brief), so a non-demo host must never boot with them. Each secret has one
  // job so a leak or rotation of one does not compromise the others.
  const cryptoSecrets = ["TOKEN_SIGNING_SECRET", "ACCESS_TOKEN_ENCRYPTION_KEY", "PRINCIPAL_HASH_SECRET"];
  const requiredSecrets = [
    ...cryptoSecrets,
    "INTERNAL_API_KEY",
    "SHOPPER_AGENT_KEY",
    "SELLER_AGENT_KEY",
  ];
  if (!demoMode) {
    const missing = requiredSecrets.filter((k) => !get(k));
    if (missing.length > 0) {
      const legacy =
        (get("TOKEN_SECRET")
          ? " TOKEN_SECRET is no longer read; it was split into TOKEN_SIGNING_SECRET, ACCESS_TOKEN_ENCRYPTION_KEY and PRINCIPAL_HASH_SECRET."
          : "") +
        (get("DEMO_AGENT_KEY") || get("MUSE_AGENT_KEY")
          ? " DEMO_AGENT_KEY and MUSE_AGENT_KEY are demo-only now; the production shopper key is SHOPPER_AGENT_KEY."
          : "");
      throw new Error(
        `[offerlayer] refusing to boot: ${missing.join(", ")} not set. ` +
          `Generate secrets with \`openssl rand -hex 32\` and set them in the environment, ` +
          `or run with OFFERLAYER_DEMO=1 for local demo mode (public demo keys only).${legacy}`,
      );
    }
    const short = requiredSecrets.filter((k) => get(k).length < (cryptoSecrets.includes(k) ? 32 : 16));
    if (short.length > 0) {
      throw new Error(
        `[offerlayer] refusing to boot: ${short.join(", ")} too short (crypto secrets need 32+ characters, keys 16+).`,
      );
    }
    for (let i = 0; i < requiredSecrets.length; i++) {
      for (let j = i + 1; j < requiredSecrets.length; j++) {
        if (get(requiredSecrets[i]) === get(requiredSecrets[j])) {
          throw new Error(
            `[offerlayer] refusing to boot: ${requiredSecrets[i]} and ${requiredSecrets[j]} must be different values.`,
          );
        }
      }
    }
    const publicDefaults = new Set<string>(Object.values(SEED_DEFAULTS));
    const reused = requiredSecrets.filter((k) => publicDefaults.has(get(k)));
    if (reused.length > 0) {
      throw new Error(`[offerlayer] refusing to boot: ${reused.join(", ")} uses a public demo value.`);
    }
    // A forged Shopify webhook can fake orders/paid -> fake conversions.
    if (get("SHOPIFY_API_KEY") && !get("SHOPIFY_API_SECRET")) {
      throw new Error(
        "[offerlayer] refusing to boot: SHOPIFY_API_KEY is set but SHOPIFY_API_SECRET is not.",
      );
    }
  }

  const database = resolveDatabase(
    get("DATABASE_URL", ""),
    demoMode,
    intEnv(get, "DB_POOL_MAX", 5),
    get("DATABASE_CA_CERT", ""),
  );
  const cronSecret = get("CRON_SECRET", "");
  if (cronSecret && cronSecret.length < 16) {
    throw new Error("[offerlayer] refusing to boot: CRON_SECRET must be 16+ characters when set.");
  }
  const portRaw = get("OFFERLAYER_API_PORT") || (get("PORT") === "8080" ? "" : get("PORT"));
  const port = Number(portRaw || "8787");
  const urls = resolveUrls(get, demoMode);
  return {
    port,
    database,
    tokenSigningSecret: get("TOKEN_SIGNING_SECRET", demoMode ? SEED_DEFAULTS.tokenSigningSecret : ""),
    accessTokenEncryptionKey: get(
      "ACCESS_TOKEN_ENCRYPTION_KEY",
      demoMode ? SEED_DEFAULTS.accessTokenEncryptionKey : "",
    ),
    principalHashSecret: get("PRINCIPAL_HASH_SECRET", demoMode ? SEED_DEFAULTS.principalHashSecret : ""),
    tokenSigningSecretPrevious: get("TOKEN_SIGNING_SECRET_PREVIOUS", ""),
    accessTokenEncryptionKeyPrevious: get("ACCESS_TOKEN_ENCRYPTION_KEY_PREVIOUS", ""),
    // The demo key only ever unlocks demo-mode routes.
    demoKey: demoMode ? get("DEMO_KEY", SEED_DEFAULTS.demoKey) : "",
    shopifyApiKey: get("SHOPIFY_API_KEY", ""),
    shopifyApiSecret: get("SHOPIFY_API_SECRET", demoMode ? SEED_DEFAULTS.shopifyApiSecret : ""),
    shopifyAppUrl: urls.shopifyApp,
    shopifyScopes: get("SHOPIFY_SCOPES", "read_products,read_orders,write_discounts"),
    internalApiKey: get("INTERNAL_API_KEY", demoMode ? SEED_DEFAULTS.internalApiKey : ""),
    shopperAgentKey: get("SHOPPER_AGENT_KEY", demoMode ? SEED_DEFAULTS.shopperAgentKey : ""),
    // Demo-only agents (the demo playground and a stand-in for one named agent).
    demoAgentKey: demoMode ? get("DEMO_AGENT_KEY", SEED_DEFAULTS.demoAgentKey) : "",
    museAgentKey: demoMode ? get("MUSE_AGENT_KEY", SEED_DEFAULTS.museAgentKey) : "",
    sellerAgentKey: get("SELLER_AGENT_KEY", demoMode ? SEED_DEFAULTS.sellerAgentKey : ""),
    urls,
    cronSecret,
    demoMode,
    limits: {
      checkoutTtlSeconds: intEnv(get, "CHECKOUT_TTL_SECONDS", 30 * 60),
      checkoutsPerMinute: intEnv(get, "CHECKOUTS_PER_MINUTE", 30),
      checkoutsPerDay: intEnv(get, "CHECKOUTS_PER_DAY", 1000),
      anonCheckoutsPerOfferPerDay: intEnv(get, "ANON_CHECKOUTS_PER_OFFER_PER_DAY", 50),
      maxOutstandingPerOffer: intEnv(get, "MAX_OUTSTANDING_CHECKOUTS_PER_OFFER", 200),
    },
  };
}
