import { accessSync, constants, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
  databaseUrl: string;
  databasePath: string;
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
  shopifyAppUrl: string;
  shopifyScopes: string;
  internalApiKey: string;
  demoAgentKey: string;
  museAgentKey: string;
  sellerAgentKey: string;
  publicBaseUrl: string;
  durablePostgres: boolean;
  /** True only when OFFERLAYER_DEMO=1. Demo-only defaults apply; never true in production. */
  demoMode: boolean;
  limits: CheckoutLimits;
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
  demoAgentKey: "agt_live_demo_v0_offerlayer_seed",
  museAgentKey: "agt_live_muse_v0_offerlayer_seed",
  sellerAgentKey: "agt_sell_demo_v0_offerlayer_seed",
} as const;

export function isPostgresUrl(url: string): boolean {
  return /^(postgres|postgresql)(\+[^:]*)?:\/\//i.test(url.trim());
}

export function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveWritableSqlitePath(preferred?: string): string {
  const candidates = [
    preferred,
    process.env.OFFERLAYER_SQLITE_PATH,
    join(tmpdir(), "offerlayer.db"),
    "/tmp/offerlayer.db",
  ].filter((p): p is string => typeof p === "string" && p.length > 0 && p !== ":memory:" && !isPostgresUrl(p));
  for (const p of candidates) {
    if (canWriteDir(dirname(p))) return p;
  }
  return ":memory:";
}

function resolveDbPath(databaseUrl: string): string {
  if (isPostgresUrl(databaseUrl)) {
    return resolveWritableSqlitePath(join(tmpdir(), "offerlayer.db"));
  }
  const raw = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  if (raw === ":memory:") return ":memory:";
  const resolved = isAbsolute(raw) ? raw : resolve(REPO_ROOT, raw);
  if (!canWriteDir(dirname(resolved))) {
    return resolveWritableSqlitePath();
  }
  return resolved;
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
  const get = (key: string, fallback = ""): string =>
    overrides[key] ?? process.env[key] ?? fallback;

  const demoMode = get("OFFERLAYER_DEMO", "") === "1";

  // Fail closed: the SEED_DEFAULTS values are public (README, connector
  // brief), so a non-demo host must never boot with them. Each secret has one
  // job so a leak or rotation of one does not compromise the others.
  const cryptoSecrets = ["TOKEN_SIGNING_SECRET", "ACCESS_TOKEN_ENCRYPTION_KEY", "PRINCIPAL_HASH_SECRET"];
  const requiredSecrets = [
    ...cryptoSecrets,
    "INTERNAL_API_KEY",
    "DEMO_AGENT_KEY",
    "MUSE_AGENT_KEY",
    "SELLER_AGENT_KEY",
  ];
  if (!demoMode) {
    const missing = requiredSecrets.filter((k) => !get(k));
    if (missing.length > 0) {
      const legacy = get("TOKEN_SECRET")
        ? " TOKEN_SECRET is no longer read; it was split into TOKEN_SIGNING_SECRET, ACCESS_TOKEN_ENCRYPTION_KEY and PRINCIPAL_HASH_SECRET."
        : "";
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

  const databaseUrl = get("DATABASE_URL", "file:./data/dev.db");
  const portRaw = get("OFFERLAYER_API_PORT") || (get("PORT") === "8080" ? "" : get("PORT"));
  const port = Number(portRaw || "8787");
  const vercelHost = get("VERCEL_PROJECT_PRODUCTION_URL") || get("VERCEL_URL");
  const onVercel = Boolean(get("VERCEL") || get("VERCEL_ENV"));
  const appUrl = get("APP_URL");
  let publicBaseUrl = get("PUBLIC_BASE_URL") || appUrl;
  if (!publicBaseUrl || /127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(publicBaseUrl)) {
    if (appUrl && !/127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(appUrl)) {
      publicBaseUrl = appUrl;
    } else if (vercelHost && !/127\.0\.0\.1|localhost/i.test(vercelHost)) {
      publicBaseUrl = vercelHost.startsWith("http") ? vercelHost : `https://${vercelHost}`;
    } else if (onVercel) {
      publicBaseUrl = "https://offerlayer.grok.me";
    } else {
      publicBaseUrl = `http://127.0.0.1:${get("PORT", "8787")}`;
    }
  }
  let shopifyAppUrl = get("SHOPIFY_APP_URL") || appUrl || "";
  if (shopifyAppUrl && /127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(shopifyAppUrl) && (onVercel || appUrl)) {
    shopifyAppUrl = /127\.0\.0\.1|localhost|0\.0\.0\.0/i.test(appUrl)
      ? publicBaseUrl
      : appUrl || publicBaseUrl;
  }
  return {
    port,
    databaseUrl,
    databasePath: resolveDbPath(databaseUrl),
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
    shopifyAppUrl,
    shopifyScopes: get("SHOPIFY_SCOPES", "read_products,read_orders,write_discounts"),
    internalApiKey: get("INTERNAL_API_KEY", demoMode ? SEED_DEFAULTS.internalApiKey : ""),
    demoAgentKey: get("DEMO_AGENT_KEY", demoMode ? SEED_DEFAULTS.demoAgentKey : ""),
    museAgentKey: get("MUSE_AGENT_KEY", demoMode ? SEED_DEFAULTS.museAgentKey : ""),
    sellerAgentKey: get("SELLER_AGENT_KEY", demoMode ? SEED_DEFAULTS.sellerAgentKey : ""),
    publicBaseUrl,
    durablePostgres: isPostgresUrl(databaseUrl),
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
