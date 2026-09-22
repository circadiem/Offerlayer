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
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "offerlayer-seller-demo-"));
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
  const shopper = keys.demoAgentKey;
  const demoKey = keys.demoKey;

  process.stdout.write(`seller ${seller.startsWith("agt_sell_") ? "agt_sell_…" : seller}\n`);
  process.stdout.write(`shopper ${shopper.startsWith("agt_live_") ? "agt_live_…" : shopper}\n`);

  const link = await req(base, "/v1/seller/links", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
    body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
  });
  process.stdout.write(`link ${link.body.pending_link_id} install=${link.body.install_url}\n`);
  process.stdout.write(`link_disclosure ${link.body.disclosure}\n`);

  const connected = await req(base, "/v1/simulate/connect_shop", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${seller}`,
      "x-demo-key": demoKey,
    },
    body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
  });
  process.stdout.write(`connected ${connected.body.status} shop=${connected.body.shop_domain}\n`);

  const proposed = await req(base, "/v1/seller/mandates", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
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
  process.stdout.write(`mandate ${proposed.body.id} ${proposed.body.status}\n`);
  process.stdout.write(`card_text ${proposed.body.card_text}\n`);
  await req(base, `/v1/seller/mandates/${proposed.body.id}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
    body: JSON.stringify({ human_confirmed: true }),
  });

  const disclosure =
    "If you buy this Organic Turkish Towel Set through this tracked checkout, the merchant funds a $4.00 buyer reward after a 14-day refund hold. The presenting agent may earn a 2% finder fee on the paid total. Nothing is paid on click or recommendation alone; refunds reverse both amounts.";
  process.stdout.write(`draft_disclosure ${disclosure}\n`);

  const published = await req(base, "/v1/seller/offers", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
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
      constraints: { clawback_days: 14, ship_to: ["US"], max_per_principal_per_day: 4 },
      disclosure,
    }),
  });
  const offerId = published.body.id as string;
  process.stdout.write(`published ${offerId}\n`);

  const search = await req(base, "/v1/offers?q=towel&ship_to=US");
  const offers = search.body.offers as { id: string }[];
  if (!offers.some((o) => o.id === offerId)) {
    throw new Error("published offer missing from public search");
  }

  const checkout = await req(base, "/v1/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shopper}` },
    body: JSON.stringify({ offer_id: offerId, principal_ref: "seller-demo-buyer" }),
  });
  const token = checkout.body.token as string;
  process.stdout.write(`token ${token.slice(0, 8)}…\n`);

  const pending = await req(base, "/v1/simulate/purchase", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${shopper}` },
    body: JSON.stringify({
      token,
      order_total: "32.00",
      currency: "USD",
      email_hash: "sha256:seller-demo-buyer",
    }),
  });
  process.stdout.write(`pending_hold ${pending.body.status} hold_until=${pending.body.hold_until}\n`);

  const perf = await req(base, `/v1/seller/offers/${offerId}/performance`, {
    headers: { authorization: `Bearer ${seller}` },
  });
  const hold = perf.body.pending_hold as { count: number; gmv: string };
  process.stdout.write(
    `performance orders=${perf.body.attributed_orders} pending_gmv=${hold.gmv} pending_count=${hold.count}\n`,
  );
  process.stdout.write("demo_seller_exit:0\n");
  } finally {
    stop?.();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
