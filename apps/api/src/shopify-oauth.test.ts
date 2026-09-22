import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, decryptSecret, encryptSecret, loadEnv, openDatabase, seedDatabase } from "@offerlayer/db";
import { createApp } from "./app.ts";
import { shopifyAdmin, signOAuthQuery, trackedCartUrl } from "./shopify-admin.ts";

const REAL_SHOP = "towels-dev.myshopify.com";
const REAL_PRODUCT = "gid://shopify/Product/9001001";
const REAL_VARIANT = "gid://shopify/ProductVariant/9002001";

describe("real Shopify OAuth + catalog", () => {
  let handle: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let sellerKey: string;
  let demoKey: string;
  let agentKey: string;
  let shopSecret: string;
  const originalFetch = shopifyAdmin.fetch;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ol-oauth-"));
    const env = loadEnv({
      DATABASE_URL: `file:${join(dir, "t.db")}`,
      SHOPIFY_API_KEY: "shpkey_test",
      SHOPIFY_API_SECRET: "shopify_oauth_secret_v0_test",
      APP_URL: "https://offerlayer.grok.me",
    });
    handle = openDatabase(env);
    const keys = seedDatabase(handle);
    sellerKey = keys.sellerAgentKey;
    demoKey = keys.demoKey;
    agentKey = keys.demoAgentKey;
    shopSecret = env.shopifyApiSecret;
    app = createApp(handle);
    shopifyAdmin.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/admin/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "shpat_live_test", scope: "read_products,read_orders" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/shop.json")) {
        return new Response(
          JSON.stringify({ shop: { id: 4242, name: "Towels Dev", myshopify_domain: REAL_SHOP } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/webhooks.json")) {
        return new Response(JSON.stringify({ webhook: { id: 1 } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/graphql.json")) {
        return new Response(
          JSON.stringify({
            data: {
              products: {
                nodes: [
                  {
                    id: REAL_PRODUCT,
                    title: "Organic Turkish Towel Set",
                    variants: { nodes: [{ id: REAL_VARIANT, price: "32.00" }] },
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("unmocked", { status: 404 });
    };
  });

  afterEach(() => {
    shopifyAdmin.fetch = originalFetch;
    closeDatabase(handle);
  });

  async function json(path: string, init: RequestInit = {}) {
    const res = await app.request(path, init);
    const body = await res.json().catch(() => ({}));
    return { res, body };
  }

  function sellerHeaders(extra: HeadersInit = {}): HeadersInit {
    return { "content-type": "application/json", authorization: `Bearer ${sellerKey}`, ...extra };
  }

  it("encrypts Shopify access tokens at rest", () => {
    const blob = encryptSecret("shpat_live_test", handle.env.tokenSecret);
    expect(blob.startsWith("enc1.")).toBe(true);
    expect(blob).not.toContain("shpat_live_test");
    expect(decryptSecret(blob, handle.env.tokenSecret)).toBe("shpat_live_test");
  });

  it("GET /auth/login with Partners key redirects to Shopify", async () => {
    const created = await json("/v1/seller/links", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ shop_domain: REAL_SHOP }),
    });
    const linkId = created.body.pending_link_id as string;
    const res = await app.request(`/auth/login?shop=${REAL_SHOP}&seller_link=${linkId}`, {
      headers: { host: "offerlayer.grok.me", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`https://${REAL_SHOP}/admin/oauth/authorize`);
    expect(location).toContain("client_id=shpkey_test");
    expect(location).toContain(encodeURIComponent("https://offerlayer.grok.me/auth/callback"));
    expect(location).not.toContain("localhost");
    expect(res.headers.get("set-cookie") ?? "").toContain(linkId);
  });

  it("GET /auth/login without Partners key stays the human HTML page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ol-oauth-nop-"));
    const env = loadEnv({ DATABASE_URL: `file:${join(dir, "t.db")}`, SHOPIFY_API_KEY: "" });
    const h = openDatabase(env);
    seedDatabase(h);
    const naked = createApp(h);
    const res = await naked.request("/auth/login?seller_link=lnk_test&shop=demo-towels.myshopify.com");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approve this shop install");
    closeDatabase(h);
  });

  it("OAuth callback verifies HMAC, stores token, completes seller_link", async () => {
    const created = await json("/v1/seller/links", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ shop_domain: REAL_SHOP }),
    });
    const linkId = created.body.pending_link_id as string;
    const query: Record<string, string> = {
      shop: REAL_SHOP,
      code: "offercode",
      state: linkId,
      timestamp: "1710000000",
    };
    query.hmac = signOAuthQuery(query, shopSecret);
    const qs = new URLSearchParams(query).toString();
    const res = await app.request(`/auth/callback?${qs}`, {
      headers: { host: "offerlayer.grok.me", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Shop connected");
    expect(html).toContain(REAL_SHOP);
    expect(html).toContain("/v1/webhooks/shopify");

    const shops = await json("/v1/seller/shops", { headers: sellerHeaders() });
    const bound = (shops.body.shops as { shop_domain: string; oauth_bound: boolean }[]).find(
      (s) => s.shop_domain === REAL_SHOP,
    );
    expect(bound?.oauth_bound).toBe(true);

    const row = handle.sqlite
      .prepare("SELECT access_token_enc, shopify_shop_id FROM merchants WHERE shop_domain = ?")
      .get(REAL_SHOP) as { access_token_enc: string; shopify_shop_id: string };
    expect(row.access_token_enc.startsWith("enc1.")).toBe(true);
    expect(row.access_token_enc).not.toContain("shpat_live_test");
    expect(row.shopify_shop_id).toContain("4242");
  });

  it("callback without HMAC is 401", async () => {
    const { res, body } = await json("/auth/callback?shop=towels-dev.myshopify.com&code=x&state=lnk_x&hmac=deadbeef");
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("HMAC_INVALID");
  });

  it("simulate shopify_oauth binds a real shop gid (not Product/1001) and lists products", async () => {
    const { res, body } = await json("/v1/simulate/shopify_oauth", {
      method: "POST",
      headers: sellerHeaders({ "x-demo-key": demoKey }),
      body: JSON.stringify({ shop_domain: REAL_SHOP, shop_name: "Towels Dev" }),
    });
    expect(res.status).toBe(201);
    expect(body.shop_domain).toBe(REAL_SHOP);
    expect(body.oauth_bound).toBe(true);
    const products = body.products as { id: string; variant_id: string; checkout_template: string }[];
    expect(products[0].id).toBe(REAL_PRODUCT);
    expect(products[0].id).not.toContain("Product/1001");
    expect(products[0].checkout_template).toBe(trackedCartUrl(REAL_SHOP, REAL_VARIANT));
    expect(products[0].checkout_template).toContain("attributes[agent_ref]={token}");

    const listed = await json(`/v1/seller/shops/${body.merchant_id}/products`, { headers: sellerHeaders() });
    expect(listed.body.products[0].id).toBe(REAL_PRODUCT);
  });

  it("GET offer checkout.ucp is true only after a real Shopify bind", async () => {
    const seed = await json("/v1/offers/off_towel_organic_set");
    expect(seed.body.checkout.ucp).toBe(false);
    expect(seed.body.checkout.tracked_url_template).toContain("{token}");

    await json("/v1/simulate/shopify_oauth", {
      method: "POST",
      headers: sellerHeaders({ "x-demo-key": demoKey }),
      body: JSON.stringify({ shop_domain: REAL_SHOP, shop_name: "Towels Dev" }),
    });
    const bound = await json("/v1/seller/shops", { headers: sellerHeaders() });
    const merch = (bound.body.shops as { shop_domain: string; oauth_bound: boolean }[]).find(
      (s) => s.shop_domain === REAL_SHOP,
    );
    expect(merch?.oauth_bound).toBe(true);

    const proposed = await json("/v1/seller/mandates", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({
        shop_domain: REAL_SHOP,
        selector: { type: "product", ids: [REAL_PRODUCT] },
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
    expect(proposed.res.status).toBe(201);
    const activated = await json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ human_confirmed: true }),
    });
    expect(activated.body.status).toBe("active");

    const published = await json("/v1/seller/offers", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({
        shop_domain: REAL_SHOP,
        status: "live",
        selector: {
          type: "product",
          ids: [REAL_PRODUCT],
          title: "Organic Turkish Towel Set",
          currency: "USD",
          list_price: "32.00",
        },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
        checkout: { tracked_url_template: trackedCartUrl(REAL_SHOP, REAL_VARIANT) },
        disclosure:
          "If you buy this Organic Turkish Towel Set through this tracked checkout, the merchant funds a $4.00 buyer reward after a 14-day refund hold.",
      }),
    });
    expect(published.res.status).toBe(201);
    const got = await json(`/v1/offers/${published.body.id}`);
    expect(got.res.status).toBe(200);
    expect(got.body.checkout.ucp).toBe(true);
    expect(got.body.checkout.tracked_url_template).toContain("9002001");
  });

  it("live GraphQL catalog is used when a real access token is stored", async () => {
    await json("/v1/simulate/shopify_oauth", {
      method: "POST",
      headers: sellerHeaders({ "x-demo-key": demoKey }),
      body: JSON.stringify({
        shop_domain: REAL_SHOP,
        products: [
          {
            id: "gid://shopify/Product/1",
            title: "Cached",
            variant_id: "gid://shopify/ProductVariant/1",
            list_price: "1.00",
          },
        ],
      }),
    });
    handle.sqlite
      .prepare("UPDATE merchants SET access_token_enc = ? WHERE shop_domain = ?")
      .run(encryptSecret("shpat_live_test", handle.env.tokenSecret), REAL_SHOP);
    const shops = await json("/v1/seller/shops", { headers: sellerHeaders() });
    const merch = (shops.body.shops as { merchant_id: string; shop_domain: string }[]).find(
      (s) => s.shop_domain === REAL_SHOP,
    );
    const listed = await json(`/v1/seller/shops/${merch?.merchant_id}/products`, { headers: sellerHeaders() });
    expect(listed.body.oauth).toBe(true);
    expect(listed.body.products[0].id).toBe(REAL_PRODUCT);
  });

  it("orders/paid with line-item properties agent_ref still attributes", async () => {
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${agentKey}` },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    const payload = JSON.stringify({
      id: 77,
      total_price: "32.00",
      currency: "USD",
      line_items: [{ properties: [{ name: "agent_ref", value: checkout.body.token }] }],
    });
    const hmac = createHmac("sha256", shopSecret).update(payload, "utf8").digest("base64");
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmac,
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("shopper key cannot simulate shopify oauth", async () => {
    const { res, body } = await json("/v1/simulate/shopify_oauth", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
        "x-demo-key": demoKey,
      },
      body: JSON.stringify({ shop_domain: REAL_SHOP }),
    });
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ROLE_MISMATCH");
  });
});
