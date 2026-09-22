import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "../apps/api/src/app.ts";

async function req(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

function mustOk(label: string, r: { status: number; body: Record<string, unknown> }, expectStatus: number) {
  if (r.status !== expectStatus) {
    throw new Error(`${label} -> ${r.status} ${JSON.stringify(r.body)}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "offerlayer-mandate-demo-"));
  const env = loadEnv({ DATABASE_URL: `file:${join(dir, "demo.db")}` });
  const handle = openDatabase(env);
  const keys = seedDatabase(handle);
  const app = createApp(handle);
  let stop: (() => void) | undefined;
  const port = await new Promise<number>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    stop = () => {
      server.close();
      handle.sqlite.close();
    };
  });
  try {
  const base = `http://127.0.0.1:${port}`;
  const seller = keys.sellerAgentKey;
  const demoKey = keys.demoKey;
  const auth = { "content-type": "application/json", authorization: `Bearer ${seller}` };

  const connected = await req(base, "/v1/simulate/connect_shop", {
    method: "POST",
    headers: { ...auth, "x-demo-key": demoKey },
    body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
  });
  mustOk("connect", connected, 201);
  process.stdout.write(`connected ${connected.body.shop_domain}\n`);

  const proposed = await req(base, "/v1/seller/mandates", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      shop_domain: "demo-towels.myshopify.com",
      selector: { type: "product", ids: ["gid://shopify/Product/1001"] },
      caps: {
        max_reward_flat: "5.00",
        max_reward_percent: "15",
        max_finder_fee_flat: "2.00",
        max_finder_fee_percent: "3",
        max_daily_liability: "200.00",
        max_clawback_days: 14,
      },
    }),
  });
  mustOk("propose", proposed, 201);
  process.stdout.write(`mandate ${proposed.body.id} status=${proposed.body.status}\n`);
  process.stdout.write(`card_text ${proposed.body.card_text}\n`);

  const activated = await req(base, `/v1/seller/mandates/${proposed.body.id}/activate`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ human_confirmed: true }),
  });
  mustOk("activate", activated, 200);
  process.stdout.write(`activated ${activated.body.status}\n`);

  const four = await req(base, "/v1/seller/offers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      shop_domain: "demo-towels.myshopify.com",
      status: "live",
      selector: {
        type: "product",
        ids: ["gid://shopify/Product/1001"],
        title: "Organic Turkish Towel Set",
        currency: "USD",
        list_price: "32.00",
      },
      reward: { type: "flat", amount: "4.00", currency: "USD" },
      finder_fee: { type: "percent", amount: "2", currency: "USD" },
      constraints: { clawback_days: 14, ship_to: ["US"] },
    }),
  });
  mustOk("offer_4", four, 201);
  process.stdout.write(`offer_4 ${four.body.id} mandate=${four.body.mandate_id}\n`);

  const eight = await req(base, "/v1/seller/offers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      shop_domain: "demo-towels.myshopify.com",
      status: "live",
      selector: {
        type: "product",
        ids: ["gid://shopify/Product/1001"],
        title: "Over cap towels",
        currency: "USD",
        list_price: "32.00",
      },
      reward: { type: "flat", amount: "8.00", currency: "USD" },
      constraints: { clawback_days: 14, ship_to: ["US"] },
    }),
  });
  if (eight.status !== 409) {
    throw new Error(`expected 409 for $8 offer, got ${eight.status} ${JSON.stringify(eight.body)}`);
  }
  const err = eight.body.error as { code?: string; card_text?: string };
  if (err?.code !== "MANDATE_EXCEEDED" || !err.card_text) {
    throw new Error(`expected MANDATE_EXCEEDED with card_text, got ${JSON.stringify(eight.body)}`);
  }
  process.stdout.write(`offer_8 rejected ${err.code}\n`);
  process.stdout.write(`exceeded_card ${err.card_text}\n`);
  process.stdout.write("demo_mandate_exit:0\n");
  } finally {
    stop?.();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
