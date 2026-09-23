import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { closeDatabase, loadEnv, openDatabase, seedDatabase, SEED_OFFER, type DbHandle } from "@offerlayer/db";
import { issueToken } from "@offerlayer/token";
import { computePayout, offerSchema, trackedCheckoutSchema } from "@offerlayer/schema";
import { TOOL_DEFS, SHOPPER_TOOL_NAMES } from "../../mcp/src/index.ts";
import { createApp } from "./app.ts";
import { REPO_ROOT } from "@offerlayer/db";

const offerJsonSchema = JSON.parse(
  readFileSync(join(REPO_ROOT, "protocol/offer.schema.json"), "utf8"),
) as object;

function hmacShopify(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("offerlayer v0", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let demoKey: string;
  let agentKey: string;
  let shopSecret: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ol-test-"));
    const env = loadEnv({ DATABASE_URL: `file:${join(dir, "t.db")}` });
    handle = openDatabase(env);
    const keys = seedDatabase(handle);
    demoKey = keys.demoKey;
    agentKey = keys.demoAgentKey;
    shopSecret = env.shopifyApiSecret;
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

  it("validates the seed towel offer against offer.schema.json", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(offerJsonSchema);
    expect(validate(SEED_OFFER), JSON.stringify(validate.errors)).toBe(true);
    expect(offerSchema.parse(SEED_OFFER).disclosure.length).toBeGreaterThanOrEqual(16);
    expect(typeof SEED_OFFER.reward.amount).toBe("string");
    expect(typeof SEED_OFFER.finder_fee.amount).toBe("string");
  });

  it("GET /health", async () => {
    const { res, body } = await json("/health");
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("search towel returns seed offer with disclosure", async () => {
    const { body } = await json("/v1/offers?q=towel&ship_to=US");
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0].id).toBe("off_towel_organic_set");
    expect(body.offers[0].disclosure.length).toBeGreaterThanOrEqual(16);
    expect(typeof body.offers[0].reward.amount).toBe("string");
  });

  it("search lawnmower returns empty list", async () => {
    const { res, body } = await json("/v1/offers?q=lawnmower");
    expect(res.status).toBe(200);
    expect(body.offers).toEqual([]);
  });

  it("checkout without bearer is 401", async () => {
    const { res, body } = await json("/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("playground header checks out without putting a key on the client", async () => {
    const { res, body } = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-offerlayer-playground": "shopper",
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    expect(res.status).toBe(201);
    expect(body.token.startsWith("olt_")).toBe(true);
    expect(JSON.stringify(body)).not.toContain(agentKey);

    const me = await json("/v1/seller/me", {
      headers: { "x-offerlayer-playground": "seller" },
    });
    expect(me.res.status).toBe(200);
    expect(me.body.role).toBe("seller");
    expect(JSON.stringify(me.body)).not.toContain(handle.env.sellerAgentKey);
  });

  it("checkout with demo agent key returns olt_ token", async () => {
    const { res, body } = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    expect(res.status).toBe(201);
    expect(body.token.startsWith("olt_")).toBe(true);
    expect(body.checkout_url).toContain(body.token);
    expect(body.disclosure.length).toBeGreaterThanOrEqual(16);
  });

  it("simulate purchase then reject second consume", async () => {
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    const token = checkout.body.token as string;
    const first = await json("/v1/simulate/purchase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({
        token,
        order_total: "32.00",
        currency: "USD",
        email_hash: "sha256:one",
      }),
    });
    expect(first.res.status).toBe(201);
    expect(first.body.status).toBe("pending_hold");
    const hold = new Date(first.body.hold_until as string).getTime();
    const expected = Date.now() + 14 * 24 * 60 * 60 * 1000;
    expect(Math.abs(hold - expected)).toBeLessThan(10_000);

    const second = await json("/v1/simulate/purchase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({
        token,
        order_total: "32.00",
        currency: "USD",
        email_hash: "sha256:one",
      }),
    });
    expect(second.res.status).toBe(409);
    expect(second.body.error.code).toBe("TOKEN_CONSUMED");
  });

  it("rejects expired tokens", async () => {
    const issued = issueToken(
      {
        offerId: "off_towel_organic_set",
        agentId: "agt_demo",
        principalHash: "anon",
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      handle.env.tokenSecret,
    );
    handle.sqlite
      .prepare(
        "INSERT INTO tokens (token_id, offer_id, agent_id, principal_hash, exp, nonce, raw_jws, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "tok_expiredtest0001",
        "off_towel_organic_set",
        "agt_demo",
        "anon",
        issued.payload.exp,
        issued.payload.nce,
        issued.token,
        new Date().toISOString(),
      );
    const { res, body } = await json("/v1/simulate/purchase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ token: issued.token, order_total: "32.00", currency: "USD" }),
    });
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("EXPIRED_TOKEN");
  });

  it("enforces max_per_principal_per_day on same email_hash", async () => {
    const email = "sha256:cap-test";
    const mk = async () => {
      const checkout = await json("/v1/checkouts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agentKey}`,
        },
        body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
      });
      return json("/v1/simulate/purchase", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${agentKey}`,
        },
        body: JSON.stringify({
          token: checkout.body.token,
          order_total: "32.00",
          currency: "USD",
          email_hash: email,
        }),
      });
    };
    const first = await mk();
    expect(first.res.status).toBe(201);
    const second = await mk();
    expect(second.res.status).toBe(409);
    expect(second.body.error.code).toBe("CAP_EXCEEDED");
  });

  it("clear hold stubs buyer $4.00 and agent $0.64", async () => {
    expect(computePayout({ type: "percent", amount: "2", orderTotal: "32.00" })).toBe("0.64");
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    await json("/v1/simulate/purchase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({
        token: checkout.body.token,
        order_total: "32.00",
        currency: "USD",
        email_hash: "sha256:clear",
      }),
    });
    const { res, body } = await json("/v1/simulate/clear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-demo-key": demoKey,
      },
      body: JSON.stringify({ token: checkout.body.token }),
    });
    expect(res.status).toBe(200);
    expect(body.status).toBe("cleared");
    const buyer = body.payouts.find((p: { party: string }) => p.party === "buyer");
    const agent = body.payouts.find((p: { party: string }) => p.party === "agent");
    expect(buyer.amount).toBe("4.00");
    expect(agent.amount).toBe("0.64");
    expect(buyer.status).toBe("stubbed");
  });

  it("orders/paid fixture with agent_ref creates pending_hold", async () => {
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    const payload = JSON.stringify({
      id: 9001,
      total_price: "32.00",
      currency: "USD",
      email: "buyer@example.com",
      note_attributes: [{ name: "agent_ref", value: checkout.body.token }],
    });
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, payload),
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("payload without token is ignored", async () => {
    const payload = JSON.stringify({
      id: 9002,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [],
    });
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, payload),
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(body.ignored).toBe(true);
  });

  it("HMAC failure is 401", async () => {
    const payload = JSON.stringify({ id: 1 });
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
      },
      body: payload,
    });
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("HMAC_INVALID");
  });

  it("refunds/create during hold claws back with no ready payouts", async () => {
    const checkout = await json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: "off_towel_organic_set" }),
    });
    const paid = JSON.stringify({
      id: 9003,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: checkout.body.token }],
    });
    await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, paid),
      },
      body: paid,
    });
    const refund = JSON.stringify({
      id: 44,
      order_id: 9003,
      order: {
        id: 9003,
        note_attributes: [{ name: "agent_ref", value: checkout.body.token }],
      },
    });
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "refunds/create",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, refund),
      },
      body: refund,
    });
    expect(res.status).toBe(200);
    expect(body.conversion.status).toBe("clawed_back");
    const ready = (body.conversion.payouts ?? []).filter((p: { status: string }) => p.status === "ready");
    expect(ready).toEqual([]);
  });

  it("MCP tools list includes disclosure guidance", () => {
    expect(SHOPPER_TOOL_NAMES).toEqual([
      "search_offers",
      "get_offer",
      "create_tracked_checkout",
      "refer_agent",
      "get_conversion",
    ]);
    const search = TOOL_DEFS.find((t) => t.name === "search_offers");
    expect(search?.description.toLowerCase()).toContain("disclosure");
  });

  it("stores api keys hashed", () => {
    const row = handle.sqlite.prepare("SELECT api_key_hash FROM agents WHERE id = ?").get("agt_demo") as {
      api_key_hash: string;
    };
    expect(row.api_key_hash).not.toBe(agentKey);
    expect(row.api_key_hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("offerlayer v0.3 shop pay attach", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let agentKey: string;
  let shopSecret: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "ol-v03-"));
    const env = loadEnv({ DATABASE_URL: `file:${join(dir, "t.db")}` });
    handle = openDatabase(env);
    const keys = seedDatabase(handle);
    agentKey = keys.demoAgentKey;
    shopSecret = env.shopifyApiSecret;
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

  async function checkout(offerId = "off_towel_organic_set") {
    return json("/v1/checkouts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${agentKey}`,
      },
      body: JSON.stringify({ offer_id: offerId }),
    });
  }

  async function paid(payload: unknown) {
    const raw = JSON.stringify(payload);
    return json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "orders/paid",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, raw),
      },
      body: raw,
    });
  }

  it("POST /v1/checkouts returns permalink + agentic and keeps checkout_url", async () => {
    const { res, body } = await checkout();
    expect(res.status).toBe(201);
    const parsed = trackedCheckoutSchema.parse(body);
    expect(parsed.token.startsWith("olt_")).toBe(true);
    expect(body.offer_id).toBe("off_towel_organic_set");
    expect(parsed.disclosure.length).toBeGreaterThanOrEqual(16);
    expect(parsed.checkout?.permalink).toBe(parsed.checkout_url);
    expect(parsed.checkout_url).toContain(`attributes[agent_ref]=${parsed.token}`);
    expect(parsed.checkout_url).toContain("utm_source=offerlayer");
    expect(parsed.checkout_url).toContain("utm_medium=agentic_commerce");
    expect(parsed.checkout_url).toContain("utm_campaign=off_towel_organic_set");
    expect(parsed.checkout_url).toContain(`utm_content=${parsed.token}`);
    expect(parsed.checkout_url).toContain("payment=shop_pay");
    expect(parsed.checkout?.agentic.line_items).toBeUndefined();
    expect(parsed.checkout?.agentic.warning).toBe("NO_VARIANT_GID");
    expect(parsed.checkout?.agentic.attributes).toEqual(
      expect.arrayContaining([
        { key: "agent_ref", value: parsed.token },
        { key: "offerlayer_offer", value: "off_towel_organic_set" },
      ]),
    );
    expect(parsed.checkout?.agentic.note).toContain(parsed.token);
  });

  it("GET /v1/offers/:id keeps checkout.ucp + tracked_url_template; seed ucp is false", async () => {
    const { res, body } = await json("/v1/offers/off_towel_organic_set");
    expect(res.status).toBe(200);
    expect(body.checkout.tracked_url_template).toContain("attributes[agent_ref]={token}");
    expect(body.checkout.ucp).toBe(false);
  });

  it("real variant gid is used in agentic.line_items", async () => {
    await json("/v1/internal/offers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-key": handle.env.demoKey },
      body: JSON.stringify({
        id: "off_variant_towels",
        shop_domain: "towels-dev.myshopify.com",
        merchant_name: "Towels Dev",
        status: "live",
        selector: {
          type: "product",
          ids: ["gid://shopify/Product/9001001", "gid://shopify/ProductVariant/9002001"],
          title: "Variant towels",
          currency: "USD",
          list_price: "32.00",
        },
        reward: { type: "flat", amount: "4.00", currency: "USD", recipient: "buyer" },
        constraints: { clawback_days: 14, ship_to: ["US"] },
        checkout: {
          tracked_url_template:
            "https://towels-dev.myshopify.com/cart/9002001:1?attributes[agent_ref]={token}",
        },
        disclosure:
          "If you buy this Variant towels through this tracked checkout, the merchant funds a $4.00 buyer reward after a 14-day refund hold.",
      }),
    });
    const { body } = await checkout("off_variant_towels");
    expect(body.checkout.agentic.line_items[0].item.id).toBe("gid://shopify/ProductVariant/9002001");
    expect(body.checkout.permalink).toContain("9002001:1");
    expect(body.checkout.agentic.warning).toBeUndefined();
  });

  it("orders/paid note_attributes agent_ref → pending_hold", async () => {
    const issued = await checkout();
    const { body } = await paid({
      id: 9301,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("orders/paid landing_site utm_content → pending_hold", async () => {
    const issued = await checkout();
    const { body } = await paid({
      id: 9302,
      total_price: "32.00",
      currency: "USD",
      landing_site: `/?utm_content=${issued.body.token}`,
    });
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("orders/paid order note containing olt_ → pending_hold", async () => {
    const issued = await checkout();
    const { body } = await paid({
      id: 9303,
      total_price: "32.00",
      currency: "USD",
      note: `offerlayer ${issued.body.token}`,
    });
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("orders/paid line-item property agent_ref → pending_hold", async () => {
    const issued = await checkout();
    const { body } = await paid({
      id: 9304,
      total_price: "32.00",
      currency: "USD",
      line_items: [{ properties: [{ name: "agent_ref", value: issued.body.token }] }],
    });
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("orders/paid with offerlayer_offer but no token is ignored and logged", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(String(chunk));
      return orig(chunk, ...(args as []));
    }) as typeof process.stdout.write;
    try {
      const { res, body } = await paid({
        id: 9305,
        total_price: "32.00",
        currency: "USD",
        myshopify_domain: "demo-towels.myshopify.com",
        note_attributes: [{ name: "offerlayer_offer", value: "off_towel_organic_set" }],
      });
      expect(res.status).toBe(200);
      expect(body.ignored).toBe(true);
      expect(body.conversion).toBeUndefined();
      expect(chunks.some((line) => line.includes("UNATTRIBUTED_PAID_ORDER"))).toBe(true);
    } finally {
      process.stdout.write = orig;
    }
  });

  it("refund during hold still claws back", async () => {
    const issued = await checkout();
    await paid({
      id: 9306,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    const refund = JSON.stringify({
      id: 55,
      order_id: 9306,
      order: { id: 9306, note: `offerlayer ${issued.body.token}` },
    });
    const { res, body } = await json("/v1/webhooks/shopify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-topic": "refunds/create",
        "x-shopify-hmac-sha256": hmacShopify(shopSecret, refund),
      },
      body: refund,
    });
    expect(res.status).toBe(200);
    expect(body.conversion.status).toBe("clawed_back");
  });
});
