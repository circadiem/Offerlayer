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
  tokenSecret: string;
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
}

/**
 * Demo-only defaults. These values are PUBLIC (they appear in the README and
 * the connector brief) and must never authenticate a non-demo host.
 * loadEnv() refuses to use them unless OFFERLAYER_DEMO=1.
 */
export const SEED_DEFAULTS = {
  tokenSecret: "offerlayer_token_secret_v0_change_me_32b",
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

export function loadEnv(overrides: Partial<Record<string, string>> = {}): OfferlayerEnv {
  const get = (key: string, fallback = ""): string =>
    overrides[key] ?? process.env[key] ?? fallback;

  const demoMode = get("OFFERLAYER_DEMO", "") === "1";

  // Fail closed: the SEED_DEFAULTS values are public (README, connector
  // brief), so a non-demo host must never boot with them. TOKEN_SECRET signs
  // checkout tokens, INTERNAL_API_KEY guards /v1/internal/*, and the agent
  // keys authenticate API callers — all must be operator-chosen per deploy.
  const requiredSecrets = [
    "TOKEN_SECRET",
    "INTERNAL_API_KEY",
    "DEMO_KEY",
    "DEMO_AGENT_KEY",
    "MUSE_AGENT_KEY",
    "SELLER_AGENT_KEY",
  ];
  if (!demoMode) {
    const missing = requiredSecrets.filter((k) => !get(k));
    if (missing.length > 0) {
      throw new Error(
        `[offerlayer] refusing to boot: ${missing.join(", ")} not set. ` +
          `Generate secrets with \`openssl rand -hex 32\` and set them in the environment, ` +
          `or run with OFFERLAYER_DEMO=1 for local demo mode (public demo keys only).`,
      );
    }
    const short = requiredSecrets.filter((k) => get(k).length < 16);
    if (short.length > 0) {
      throw new Error(
        `[offerlayer] refusing to boot: ${short.join(", ")} shorter than 16 characters.`,
      );
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
  const tokenSecret = get("TOKEN_SECRET", demoMode ? SEED_DEFAULTS.tokenSecret : "");
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
    tokenSecret: tokenSecret.length >= 16 ? tokenSecret : SEED_DEFAULTS.tokenSecret,
    demoKey: get("DEMO_KEY", demoMode ? SEED_DEFAULTS.demoKey : ""),
    shopifyApiKey: get("SHOPIFY_API_KEY", ""),
    shopifyApiSecret: get("SHOPIFY_API_SECRET", demoMode ? SEED_DEFAULTS.shopifyApiSecret : ""),
    shopifyAppUrl,
    shopifyScopes: get("SHOPIFY_SCOPES", "read_products,read_orders,write_orders,read_customers,write_discounts"),
    internalApiKey: get("INTERNAL_API_KEY", demoMode ? SEED_DEFAULTS.internalApiKey : ""),
    demoAgentKey: get("DEMO_AGENT_KEY", demoMode ? SEED_DEFAULTS.demoAgentKey : ""),
    museAgentKey: get("MUSE_AGENT_KEY", demoMode ? SEED_DEFAULTS.museAgentKey : ""),
    sellerAgentKey: get("SELLER_AGENT_KEY", demoMode ? SEED_DEFAULTS.sellerAgentKey : ""),
    publicBaseUrl,
    durablePostgres: isPostgresUrl(databaseUrl),
    demoMode,
  };
}
