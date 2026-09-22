// Demo scripts always run in demo mode (public demo keys). Production entrypoints
// (apps/api, apps/mcp, apps/shopify) must NOT set this — they fail closed.
process.env.OFFERLAYER_DEMO ??= "1";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "../apps/api/src/app.ts";

const SHOP = "towels-dev.myshopify.com";

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
  const dir = mkdtempSync(join(tmpdir(), "offerlayer-shopify-demo-"));
  const env = loadEnv({
    DATABASE_URL: `file:${join(dir, "demo.db")}`,
    APP_URL: "https://offerlayer.grok.me",
  });
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

    process.stdout.write("shop towels-dev.myshopify.com (not demo-towels)\n");

    const oauth = await req(base, "/v1/simulate/shopify_oauth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${seller}`,
        "x-demo-key": demoKey,
      },
      body: JSON.stringify({ shop_domain: SHOP, shop_name: "Towels Dev" }),
    });
    const merchantId = oauth.body.merchant_id as string;
    process.stdout.write(`oauth_bound ${oauth.body.oauth_bound} merchant=${merchantId}\n`);

    const catalog = await req(base, `/v1/seller/shops/${merchantId}/products`, {
      headers: { authorization: `Bearer ${seller}` },
    });
    const products = catalog.body.products as { id: string; variant_id: string; checkout_template: string }[];
    if (!products.length || products[0].id === "gid://shopify/Product/1001") {
      throw new Error("expected a real product gid, not Product/1001");
    }
    const product = products[0];
    process.stdout.write(`product ${product.id} variant=${product.variant_id}\n`);
    process.stdout.write(`checkout_template ${product.checkout_template}\n`);

    const proposed = await req(base, "/v1/seller/mandates", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
      body: JSON.stringify({
        shop_domain: SHOP,
        selector: { type: "product", ids: [product.id] },
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
    process.stdout.write(`mandate ${proposed.body.id} card_text=${proposed.body.card_text}\n`);
    await req(base, `/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
      body: JSON.stringify({ human_confirmed: true }),
    });

    const published = await req(base, "/v1/seller/offers", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${seller}` },
      body: JSON.stringify({
        shop_domain: SHOP,
        status: "live",
        selector: {
          type: "product",
          ids: [product.id],
          title: "Organic Turkish Towel Set",
          currency: "USD",
          list_price: "32.00",
        },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        finder_fee: { type: "percent", amount: "2", currency: "USD" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
        checkout: { tracked_url_template: product.checkout_template },
      }),
    });
    const offerId = published.body.id as string;
    if ((published.body.selector as { ids?: string[] })?.ids?.[0] === "gid://shopify/Product/1001") {
      throw new Error("published seed gid");
    }
    process.stdout.write(`published ${offerId} mandate_id=${published.body.mandate_id}\n`);

    const checkout = await req(base, "/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shopper}` },
      body: JSON.stringify({ offer_id: offerId, principal_ref: "real-shop-buyer" }),
    });
    const token = checkout.body.token as string;
    const checkoutUrl = checkout.body.checkout_url as string;
    if (!checkoutUrl.includes("attributes[agent_ref]=") || !checkoutUrl.includes(token)) {
      throw new Error(`checkout_url missing agent_ref token: ${checkoutUrl}`);
    }
    if (!checkoutUrl.includes("9002001")) {
      throw new Error(`checkout_url should use the real variant, got ${checkoutUrl}`);
    }
    process.stdout.write(`checkout_url ${checkoutUrl}\n`);

    const paid = JSON.stringify({
      id: 88001,
      total_price: "32.00",
      currency: "USD",
      email: "buyer@example.com",
      note_attributes: [{ name: "agent_ref", value: token }],
    });
    const hmac = createHmac("sha256", env.shopifyApiSecret).update(paid, "utf8").digest("base64");
    const webhook = await req(base, "/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmac,
      },
      body: paid,
    });
    const conversion = webhook.body.conversion as { status: string };
    if (conversion.status !== "pending_hold") {
      throw new Error(`expected pending_hold from orders/paid, got ${conversion.status}`);
    }
    process.stdout.write(`webhook_orders_paid ${conversion.status}\n`);

    const status = await req(base, `/v1/conversions/${encodeURIComponent(token)}`, {
      headers: { authorization: `Bearer ${shopper}` },
    });
    process.stdout.write(`conversion ${status.body.status} (not paid)\n`);

    const perf = await req(base, `/v1/seller/offers/${offerId}/performance`, {
      headers: { authorization: `Bearer ${seller}` },
    });
    process.stdout.write(`performance orders=${perf.body.attributed_orders}\n`);

    const refund = JSON.stringify({
      id: 9,
      order_id: 88001,
      order: { id: 88001, note_attributes: [{ name: "agent_ref", value: token }] },
    });
    const refundHmac = createHmac("sha256", env.shopifyApiSecret).update(refund, "utf8").digest("base64");
    const clawed = await req(base, "/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "refunds/create",
        "x-shopify-hmac-sha256": refundHmac,
      },
      body: refund,
    });
    process.stdout.write(`webhook_refund ${(clawed.body.conversion as { status: string }).status}\n`);
    process.stdout.write("demo_shopify_exit:0\n");
  } finally {
    stop?.();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
