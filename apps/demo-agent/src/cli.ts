import { SEED_DEFAULTS } from "@offerlayer/db";

const base = process.env.OFFERLAYER_URL ?? "http://127.0.0.1:8787";
const agentKey = process.env.DEMO_AGENT_KEY ?? SEED_DEFAULTS.demoAgentKey;
const demoKey = process.env.DEMO_KEY ?? SEED_DEFAULTS.demoKey;

async function req(path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

export async function runDemo(): Promise<void> {
  const health = (await req("/health")) as { ok: boolean };
  process.stdout.write(`health ${JSON.stringify(health)}\n`);

  const search = (await req("/v1/offers?q=towel&ship_to=US")) as { offers: { id: string; disclosure: string }[] };
  process.stdout.write(`search ${search.offers.length} offer(s)\n`);
  for (const o of search.offers) {
    process.stdout.write(`  ${o.id} disclosure=${o.disclosure.slice(0, 48)}…\n`);
  }
  const offer = search.offers[0];
  if (!offer) throw new Error("expected seed towel offer");

  const checkout = (await req("/v1/checkouts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agentKey}`,
    },
    body: JSON.stringify({ offer_id: offer.id, principal_ref: "demo-buyer@example.com" }),
  })) as { token: string; checkout_url: string; disclosure: string };

  process.stdout.write(`token ${checkout.token.slice(0, 8)}…\n`);
  process.stdout.write(`checkout_url ${checkout.checkout_url.includes(checkout.token) ? "contains token" : "MISSING TOKEN"}\n`);
  process.stdout.write(`disclosure ${checkout.disclosure}\n`);

  const pending = (await req("/v1/simulate/purchase", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agentKey}`,
    },
    body: JSON.stringify({
      token: checkout.token,
      order_total: "32.00",
      currency: "USD",
      email_hash: "sha256:demo-buyer",
    }),
  })) as { status: string; hold_until?: string };

  process.stdout.write(`simulate ${pending.status} hold_until=${pending.hold_until}\n`);

  const cleared = (await req("/v1/simulate/clear", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-demo-key": demoKey,
    },
    body: JSON.stringify({ token: checkout.token }),
  })) as { status: string; payouts?: { party: string; amount: string; status: string }[] };

  process.stdout.write(`cleared ${cleared.status}\n`);
  for (const p of cleared.payouts ?? []) {
    process.stdout.write(`  payout ${p.party} ${p.amount} ${p.status}\n`);
  }
}

if (process.argv[1]?.endsWith("cli.ts")) {
  runDemo().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
