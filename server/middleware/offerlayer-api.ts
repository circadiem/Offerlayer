/**
 * Mount the Offerlayer Hono API on the Nitro/Vercel server so production
 * preview (and deploy) serve /health and /v1 without a separate process.
 *
 * Health is answered here with no native modules and no filesystem writes so
 * Muse (and any agent) can reach the protocol even if SQLite fails to open.
 * The SQLite protocol store lives on a writable path (/tmp on Vercel) and is
 * snapshotted to Neon when DATABASE_URL is postgres.
 */
import { VERSION } from "../../apps/api/src/version.ts";

type Event = {
  url: URL;
  req: Request;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "Authorization, Content-Type, x-demo-key, x-internal-key",
  "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
};

type Booted = {
  app: { fetch: (req: Request) => Response | Promise<Response> };
  persistAfterWrite: () => Promise<void>;
};

let bootPromise: Promise<Booted> | null = null;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function log(event: Record<string, unknown>): void {
  const line = { ts: new Date().toISOString(), ...event };
  try {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  } catch {
    // ignore
  }
}

function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/(postgres|postgresql)(\+[^:]*)?:\/\/[^\s]+/gi, "postgres://[redacted]")
    .replace(/file:\/[^\s]+/g, "file:[redacted]");
}

function isApiPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/auth/login" ||
    path === "/auth/callback" ||
    path === "/auth/demo-complete" ||
    path === "/openapi.yaml" ||
    path === "/v1" ||
    path.startsWith("/v1/") ||
    path.startsWith("/.well-known/") ||
    path === "/mcp" ||
    path.startsWith("/mcp/")
  );
}

function toFetchRequest(event: Event): Request {
  const src = event.req;
  const headers = new Headers(src.headers);
  const host = event.url.host;
  if (host) {
    headers.set("host", host);
    headers.set("x-forwarded-host", host);
  }
  const proto = event.url.protocol.replace(":", "");
  if (proto) headers.set("x-forwarded-proto", proto);
  const method = src.method || "GET";
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = src.body;
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }
  try {
    return new Request(event.url.toString(), init);
  } catch {
    return src;
  }
}

async function boot(): Promise<Booted> {
  const db = await import("@offerlayer/db");
  const { createApp } = await import("../../apps/api/src/app.ts");
  const env = db.loadEnv();
  log({
    level: "info",
    msg: "offerlayer_boot",
    sqlite_path: env.databasePath,
    durable: env.durablePostgres,
    public_base: env.publicBaseUrl,
  });
  if (env.durablePostgres && env.databasePath !== ":memory:") {
    const restored = await db.restoreSqliteFile(env.databasePath);
    log({ level: "info", msg: "sqlite_restore", restored });
  }
  const handle = db.openDatabase(env);
  db.seedDatabase(handle);
  const app = createApp(handle);
  return {
    app,
    persistAfterWrite: () => db.persistSqliteHandle(handle),
  };
}

function getBoot(): Promise<Booted> {
  bootPromise ??= boot().catch((err) => {
    bootPromise = null;
    throw err;
  });
  return bootPromise;
}

export default async function offerlayerApi(
  event: Event,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  const path = event.url.pathname;
  if (!isApiPath(path)) return next();

  if ((event.req.method || "GET") === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (path === "/health" && (event.req.method || "GET") === "GET") {
    return json(200, { ok: true, version: VERSION });
  }

  try {
    const booted = await getBoot();
    const req = toFetchRequest(event);
    const res = await booted.app.fetch(req);
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      await booted.persistAfterWrite().catch((err) => {
        log({ level: "error", msg: "persist_failed", error: safeMessage(err) });
      });
    }
    return res;
  } catch (err) {
    log({
      level: "error",
      msg: "unhandled_api",
      path,
      error: safeMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    if (path === "/v1/offers" && (event.req.method || "GET") === "GET") {
      return json(200, { offers: [] });
    }
    return json(500, {
      error: {
        code: "INTERNAL",
        message: safeMessage(err),
      },
    });
  }
}
