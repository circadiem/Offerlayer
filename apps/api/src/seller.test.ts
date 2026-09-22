import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  hashApiKey,
  loadEnv,
  openDatabase,
  seedDatabase,
  type DbHandle,
} from "@offerlayer/db";
import { agents } from "@offerlayer/db";
import { SELLER_TOOL_DEFS, SELLER_TOOL_NAMES, SHOPPER_TOOL_NAMES, toolsForKeys } from "../../mcp/src/index.ts";
import { createApp } from "./app.ts";

describe("offerlayer v0.1 seller", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let demoKey: string;
  let shopperKey: string;
  let sellerKey: string;
  let otherSellerKey: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ol-seller-"));
    const env = loadEnv({ DATABASE_URL: `file:${join(dir, "t.db")}` });
    handle = openDatabase(env);
    const keys = seedDatabase(handle);
    demoKey = keys.demoKey;
    shopperKey = keys.demoAgentKey;
    sellerKey = keys.sellerAgentKey;
    otherSellerKey = "agt_sell_other_v0_offerlayer";
    handle.db
      .insert(agents)
      .values({
        id: "agt_seller_other",
        name: "Other Seller",
        publicKey: null,
        apiKeyHash: hashApiKey(otherSellerKey),
        status: "active",
        role: "seller",
        createdAt: new Date().toISOString(),
      })
      .run();
    app = createApp(handle);
  });

  afterEach(() => {
    closeDatabase(handle);
  });

  async function json(path: string, init: RequestInit = {}) {
    const res = await app.request(path, init);
    const body = await res.json();
    return { res, body };
  }

  function sellerHeaders(key = sellerKey): HeadersInit {
    return { "content-type": "application/json", authorization: `Bearer ${key}` };
  }

  async function connectAndMandate() {
    await json("/v1/simulate/connect_shop", {
      method: "POST",
      headers: { ...sellerHeaders(), "x-demo-key": demoKey },
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    const proposed = await json("/v1/seller/mandates", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({
        shop_domain: "demo-towels.myshopify.com",
        selector: { type: "shop" },
        caps: {
          max_reward_flat: "50.00",
          max_reward_percent: "50",
          max_finder_fee_flat: "20.00",
          max_finder_fee_percent: "20",
          max_daily_liability: "500.00",
          max_clawback_days: 30,
        },
      }),
    });
    await json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ human_confirmed: true }),
    });
  }

  it("seed prints hashed seller and shopper keys", () => {
    expect(sellerKey.startsWith("agt_sell_")).toBe(true);
    expect(shopperKey.startsWith("agt_live_")).toBe(true);
    const seller = handle.sqlite.prepare("SELECT role, api_key_hash FROM agents WHERE id = ?").get("agt_seller") as {
      role: string;
      api_key_hash: string;
    };
    expect(seller.role).toBe("seller");
    expect(seller.api_key_hash).not.toBe(sellerKey);
  });

  it("seller key cannot checkout", async () => {
    const { res, body } = await json("/v1/checkouts", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ROLE_MISMATCH");
  });

  it("shopper key cannot hit seller routes", async () => {
    const { res, body } = await json("/v1/seller/shops", {
      headers: { authorization: `Bearer ${shopperKey}` },
    });
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ROLE_MISMATCH");
  });

  it("creates a shop link with install_url and disclosure", async () => {
    const { res, body } = await json("/v1/seller/links", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    expect(res.status).toBe(201);
    expect(body.pending_link_id).toMatch(/^lnk_/);
    expect(body.install_url).toContain("seller_link=");
    expect(body.install_url).toContain("/auth/login");
    expect(body.disclosure).toMatch(/human must approve/i);
    expect(body.demo_complete_url).toContain("/v1/seller/links/");
  });

  it("public Host rewrites install_url off localhost", async () => {
    const { res, body } = await json("/v1/seller/links", {
      method: "POST",
      headers: { ...sellerHeaders(), host: "offerlayer.grok.me", "x-forwarded-proto": "https" },
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    expect(res.status).toBe(201);
    expect(body.install_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/auth\/login/);
    expect(body.demo_complete_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/v1\/seller\/links\//);
    expect(body.install_url).not.toContain("localhost");
    expect(body.demo_complete_url).not.toContain("127.0.0.1");
  });

  it("VERCEL without Host still emits grok.me install URLs", async () => {
    const prev = process.env.VERCEL;
    process.env.VERCEL = "1";
    try {
      const { res, body } = await json("/v1/seller/links", {
        method: "POST",
        headers: sellerHeaders(),
        body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
      });
      expect(res.status).toBe(201);
      expect(body.install_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/auth\/login/);
      expect(body.demo_complete_url).toMatch(/^https:\/\/offerlayer\.grok\.me\/v1\/seller\/links\//);
      expect(body.install_url).not.toContain("localhost");
    } finally {
      if (prev === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prev;
    }
  });

  it("GET /auth/login is the human install page", async () => {
    const res = await app.request("/auth/login?seller_link=lnk_test&shop=demo-towels.myshopify.com");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Approve this shop install");
    expect(html).toContain("lnk_test");
  });

  it("complete without bearer is 401; with seller bearer connects", async () => {
    const created = await json("/v1/seller/links", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    const id = created.body.pending_link_id as string;
    const noAuth = await json(`/v1/seller/links/${id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    expect(noAuth.res.status).toBe(401);
    const ok = await json(`/v1/seller/links/${id}/complete`, {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    expect(ok.res.status).toBe(200);
    expect(ok.body.status).toBe("connected");
  });

  it("simulate connect_shop grants the demo shop", async () => {
    const { res, body } = await json("/v1/simulate/connect_shop", {
      method: "POST",
      headers: { ...sellerHeaders(), "x-demo-key": demoKey },
      body: JSON.stringify({ shop_domain: "demo-towels.myshopify.com" }),
    });
    expect(res.status).toBe(201);
    expect(body.status).toBe("connected");
    const shops = await json("/v1/seller/shops", { headers: sellerHeaders() });
    expect(shops.body.shops.some((s: { shop_domain: string }) => s.shop_domain === "demo-towels.myshopify.com")).toBe(
      true,
    );
  });

  it("seller CRUD, public search, pause/resume, second seller forbidden", async () => {
    await connectAndMandate();

    const created = await json("/v1/seller/offers", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({
        shop_domain: "demo-towels.myshopify.com",
        status: "live",
        selector: {
          type: "product",
          ids: ["gid://shopify/Product/2002"],
          title: "Seller Towel Bundle",
          currency: "USD",
          list_price: "32.00",
        },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        finder_fee: { type: "percent", amount: "2", currency: "USD" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
      }),
    });
    expect(created.res.status).toBe(201);
    expect(created.body.disclosure.length).toBeGreaterThanOrEqual(16);
    const offerId = created.body.id as string;
    expect(created.body.mandate_id).toMatch(/^man_/);

    const listed = await json("/v1/seller/offers", { headers: sellerHeaders() });
    const listedOffer = listed.body.offers.find((o: { id: string }) => o.id === offerId) as
      | { id: string; mandate_id?: string }
      | undefined;
    expect(listedOffer?.mandate_id).toMatch(/^man_/);

    const search = await json("/v1/offers?q=Seller%20Towel&ship_to=US");
    expect(search.body.offers.some((o: { id: string }) => o.id === offerId)).toBe(true);

    const otherPatch = await json(`/v1/seller/offers/${offerId}`, {
      method: "PATCH",
      headers: sellerHeaders(otherSellerKey),
      body: JSON.stringify({ status: "paused" }),
    });
    expect(otherPatch.res.status).toBe(403);

    const paused = await json(`/v1/seller/offers/${offerId}/pause`, {
      method: "POST",
      headers: sellerHeaders(),
    });
    expect(paused.body.status).toBe("paused");
    const hidden = await json("/v1/offers?q=Seller%20Towel&ship_to=US");
    expect(hidden.body.offers.some((o: { id: string }) => o.id === offerId)).toBe(false);

    const resumed = await json(`/v1/seller/offers/${offerId}/resume`, {
      method: "POST",
      headers: sellerHeaders(),
    });
    expect(resumed.body.status).toBe("live");
  });

  it("performance after shopper simulate purchase", async () => {
    await connectAndMandate();
    const created = await json("/v1/seller/offers", {
      method: "POST",
      headers: sellerHeaders(),
      body: JSON.stringify({
        shop_domain: "demo-towels.myshopify.com",
        status: "live",
        selector: {
          type: "product",
          title: "Perf Towels",
          currency: "USD",
          list_price: "32.00",
        },
        reward: { type: "flat", amount: "4.00", currency: "USD" },
        finder_fee: { type: "percent", amount: "2", currency: "USD" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
      }),
    });
    const offerId = created.body.id as string;
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shopperKey}` },
      body: JSON.stringify({ offer_id: offerId, principal_ref: "perf-buyer" }),
    });
    await json("/v1/simulate/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${shopperKey}` },
      body: JSON.stringify({
        token: checkout.body.token,
        order_total: "32.00",
        currency: "USD",
        email_hash: "sha256:perf",
      }),
    });
    const perf = await json(`/v1/seller/offers/${offerId}/performance`, { headers: sellerHeaders() });
    expect(perf.body.attributed_orders).toBe(1);
    expect(perf.body.pending_hold.count).toBe(1);
  });

  it("MCP seller vs shopper tool split", () => {
    expect(toolsForKeys({ agentKey: "x" })).toEqual([...SHOPPER_TOOL_NAMES]);
    expect(toolsForKeys({ sellerKey: "x" })).toEqual([...SELLER_TOOL_NAMES]);
    const link = SELLER_TOOL_DEFS.find((t) => t.name === "create_shop_link");
    expect(link?.description).toContain("install_url");
    expect(link?.description).toMatch(/human/i);
  });
});
