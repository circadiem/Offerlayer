/**
 * Production boot check. Point it at a running server that was started
 * WITHOUT OFFERLAYER_DEMO; it fails if any demo route is reachable or the API
 * is not serving.
 *
 *   BASE_URL=http://127.0.0.1:8081 pnpm check:prod-boot
 *
 * CI runs it against the built bundle (see .github/workflows/ci.yml).
 */
const base = (process.env.BASE_URL ?? "http://127.0.0.1:8081").replace(/\/$/, "");

/** Routes that exist only in demo mode. Every one must 404 in production. */
const DEMO_ONLY: [string, string][] = [
  ["POST", "/v1/simulate/purchase"],
  ["POST", "/v1/simulate/clear"],
  ["POST", "/v1/simulate/shopify_oauth"],
  ["POST", "/v1/simulate/connect_shop"],
  ["GET", "/v1/internal/seed"],
  ["POST", "/auth/demo-complete"],
];

const failures: string[] = [];

async function call(method: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}",
  });
  return { status: res.status, text: await res.text() };
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${base} did not become healthy`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

await waitForHealth();

for (const [method, path] of DEMO_ONLY) {
  // Send a demo key and the playground header too: neither may unlock anything.
  const { status } = await call(method, path, {
    "x-demo-key": "offerlayer_demo_v0",
    "x-offerlayer-playground": "shopper",
  });
  if (status !== 404) failures.push(`${method} ${path} returned ${status}, expected 404`);
}

const playground = await call("POST", "/v1/checkouts", { "x-offerlayer-playground": "shopper" });
if (playground.status !== 401) {
  failures.push(`playground header on POST /v1/checkouts returned ${playground.status}, expected 401`);
}

// The API must be serving from the database, not just the static health check.
const offers = await call("GET", "/v1/offers");
if (offers.status !== 200 || !offers.text.includes('"offers"')) {
  failures.push(`GET /v1/offers returned ${offers.status}: ${offers.text.slice(0, 200)}`);
}

if (failures.length > 0) {
  console.error(`[prod-boot-check] FAILED against ${base}:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[prod-boot-check] ok: ${DEMO_ONLY.length} demo routes return 404, API serving at ${base}`);

export {};
