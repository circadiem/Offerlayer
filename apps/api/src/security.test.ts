/**
 * Phase 0 regression tests (OFFERLAYER_LAUNCH.md §2). Each block maps to one
 * numbered fix and failed before it.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  closeDatabase,
  decryptSecret,
  encryptSecret,
  eq,
  loadEnv,
  migrate,
  openDatabase,
  seedDatabase,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { createApp } from "./app.ts";
import { recordPaidOrder } from "./conversion-machine.ts";
import { cleanupExpiredDiscounts } from "./discount-cleanup.ts";
import { pgSslConfig } from "../../../packages/db/src/persist.ts";
import { shopifyAdmin, type ShopifyFetch } from "./shopify-admin.ts";

const DEMO_SHOP = "demo-towels.myshopify.com";
const OFFER = "off_towel_organic_set";

const PROD_SECRETS = {
  OFFERLAYER_DEMO: "",
  TOKEN_SIGNING_SECRET: "sig_" + "1".repeat(40),
  ACCESS_TOKEN_ENCRYPTION_KEY: "enc_" + "2".repeat(40),
  PRINCIPAL_HASH_SECRET: "prn_" + "3".repeat(40),
  INTERNAL_API_KEY: "int_" + "4".repeat(28),
  DEMO_AGENT_KEY: "agt_live_" + "5".repeat(28),
  MUSE_AGENT_KEY: "agt_live_" + "6".repeat(28),
  SELLER_AGENT_KEY: "agt_sell_" + "7".repeat(28),
  SHOPIFY_API_KEY: "shopify_key",
  SHOPIFY_API_SECRET: "shpss_" + "8".repeat(28),
};

function tempDb(): string {
  return `file:${join(mkdtempSync(join(tmpdir(), "ol-sec-")), "t.db")}`;
}

/** Stand-in for the Shopify Admin GraphQL API. Records every call. */
function fakeShopify() {
  const calls: { url: string; query: string; variables: Record<string, unknown> }[] = [];
  let next = 1;
  const failDeletes = { value: false };
  const fetch: ShopifyFetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query: string;
      variables: Record<string, unknown>;
    };
    calls.push({ url: String(input), query: body.query, variables: body.variables });
    if (body.query.includes("discountCodeBasicCreate")) {
      const id = `gid://shopify/DiscountCodeNode/${next++}`;
      return Response.json({
        data: { discountCodeBasicCreate: { codeDiscountNode: { id }, userErrors: [] } },
      });
    }
    if (body.query.includes("discountCodeDelete")) {
      if (failDeletes.value) {
        return Response.json({
          data: {
            discountCodeDelete: {
              deletedCodeDiscountId: null,
              userErrors: [{ message: "Throttled" }],
            },
          },
        });
      }
      return Response.json({
        data: { discountCodeDelete: { deletedCodeDiscountId: body.variables.id, userErrors: [] } },
      });
    }
    return Response.json({ errors: [{ message: "unexpected query" }] }, { status: 400 });
  };
  return { calls, fetch, failDeletes };
}

function harness(overrides: Record<string, string> = {}) {
  const env = loadEnv({ DATABASE_URL: tempDb(), ...overrides });
  const handle = openDatabase(env);
  const keys = seedDatabase(handle);
  const app = createApp(handle);
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, init);
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { res, body };
  };
  const checkout = (body: Record<string, unknown> = { offer_id: OFFER }, key = keys.demoAgentKey) =>
    json("/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  const webhook = (
    topic: string,
    payload: unknown,
    opts: { shop?: string | null; webhookId?: string } = {},
  ) => {
    const raw = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-hmac-sha256": createHmac("sha256", env.shopifyApiSecret)
        .update(raw, "utf8")
        .digest("base64"),
    };
    const shop = opts.shop === undefined ? DEMO_SHOP : opts.shop;
    if (shop) headers["x-shopify-shop-domain"] = shop;
    if (opts.webhookId) headers["x-shopify-webhook-id"] = opts.webhookId;
    return json("/v1/webhooks/shopify", { method: "POST", headers, body: raw });
  };
  const bindShop = () =>
    handle.sqlite
      .prepare("UPDATE merchants SET access_token_enc = ? WHERE shop_domain = ?")
      .run(encryptSecret("shpat_test", env.accessTokenEncryptionKey), DEMO_SHOP);
  return { env, handle, keys, app, json, checkout, webhook, bindShop };
}

let realFetch: ShopifyFetch;
const open: DbHandle[] = [];
beforeEach(() => {
  realFetch = shopifyAdmin.fetch;
});
afterEach(() => {
  shopifyAdmin.fetch = realFetch;
  while (open.length) closeDatabase(open.pop()!);
});
function track<T extends { handle: DbHandle }>(h: T): T {
  open.push(h.handle);
  return h;
}

describe("§2.1 demo and internal routes are unreachable in production", () => {
  const demoOnly: [string, string][] = [
    ["POST", "/v1/simulate/purchase"],
    ["POST", "/v1/simulate/clear"],
    ["POST", "/v1/simulate/shopify_oauth"],
    ["POST", "/v1/simulate/connect_shop"],
    ["GET", "/v1/internal/seed"],
    ["POST", "/auth/demo-complete"],
  ];

  it("returns 404 for every demo route, even with valid keys", async () => {
    const h = track(harness(PROD_SECRETS));
    for (const [method, path] of demoOnly) {
      const { res, body } = await h.json(path, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${PROD_SECRETS.DEMO_AGENT_KEY}`,
          "x-internal-key": PROD_SECRETS.INTERNAL_API_KEY,
        },
        body:
          method === "GET"
            ? undefined
            : JSON.stringify({ token: "olt_x", order_total: "1.00", currency: "USD" }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(body.error.code).toBe("NOT_FOUND");
    }
  });

  it("a shopper key cannot fabricate a paid conversion", async () => {
    const h = track(harness(PROD_SECRETS));
    const issued = await h.checkout({ offer_id: OFFER }, PROD_SECRETS.DEMO_AGENT_KEY);
    expect(issued.res.status).toBe(201);
    const fake = await h.json("/v1/simulate/purchase", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${PROD_SECRETS.DEMO_AGENT_KEY}`,
      },
      body: JSON.stringify({ token: issued.body.token, order_total: "9999.00", currency: "USD" }),
    });
    expect(fake.res.status).toBe(404);
    // The token is still unspent, so the real webhook can attribute it.
    const paid = await h.webhook("orders/paid", {
      id: 1,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    expect(paid.body.conversion.status).toBe("pending_hold");
  });

  it("the playground header does not sign anyone in", async () => {
    const h = track(harness(PROD_SECRETS));
    const { res } = await h.json("/v1/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json", "x-offerlayer-playground": "shopper" },
      body: JSON.stringify({ offer_id: OFFER }),
    });
    expect(res.status).toBe(401);
  });

  it("a seller key cannot bind a shop without Shopify OAuth", async () => {
    const h = track(harness(PROD_SECRETS));
    const seller = {
      "content-type": "application/json",
      authorization: `Bearer ${PROD_SECRETS.SELLER_AGENT_KEY}`,
    };
    const link = await h.json("/v1/seller/links", {
      method: "POST",
      headers: seller,
      body: JSON.stringify({ shop_domain: "someone-elses-shop.myshopify.com" }),
    });
    expect(link.res.status).toBe(201);
    expect(link.body.demo_complete_url).toBeUndefined();
    const done = await h.json(`/v1/seller/links/${link.body.pending_link_id}/complete`, {
      method: "POST",
      headers: seller,
      body: JSON.stringify({ shop_domain: "someone-elses-shop.myshopify.com" }),
    });
    expect(done.res.status).toBe(403);
    expect(done.body.error.code).toBe("OAUTH_REQUIRED");
  });

  it("demo mode still serves the simulate routes", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    const { res } = await h.json("/v1/simulate/purchase", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-key": h.keys.demoKey },
      body: JSON.stringify({ token: issued.body.token, order_total: "32.00", currency: "USD" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("§2.2 discount-code minting is bounded", () => {
  it("rate-limits a key with 429 before any Shopify call", async () => {
    const h = track(harness({ CHECKOUTS_PER_MINUTE: "3" }));
    const shopify = fakeShopify();
    shopifyAdmin.fetch = shopify.fetch;
    h.bindShop();
    for (let i = 0; i < 3; i++) {
      const { res } = await h.checkout({
        offer_id: OFFER,
        principal_ref: `shopper-${i}@example.com`,
      });
      expect(res.status).toBe(201);
    }
    expect(shopify.calls).toHaveLength(3);
    for (let i = 0; i < 5; i++) {
      const { res, body } = await h.checkout({
        offer_id: OFFER,
        principal_ref: `late-${i}@example.com`,
      });
      expect(res.status).toBe(429);
      expect(body.error.code).toBe("RATE_LIMITED");
    }
    expect(shopify.calls).toHaveLength(3);
    // Another key is unaffected.
    const other = await h.checkout({ offer_id: OFFER }, h.keys.museAgentKey);
    expect(other.res.status).toBe(201);
  });

  it("honors a per-key override", async () => {
    const h = track(harness());
    h.handle.db.update(agents).set({ ratePerMinute: 1 }).where(eq(agents.id, "agt_demo")).run();
    expect((await h.checkout()).res.status).toBe(201);
    expect((await h.checkout()).res.status).toBe(429);
  });

  it("refer counts against the calling key", async () => {
    const h = track(harness({ CHECKOUTS_PER_MINUTE: "1" }));
    const refer = () =>
      h.json("/v1/refer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${h.keys.demoAgentKey}`,
        },
        body: JSON.stringify({ offer_id: OFFER, to_agent_id: "agt_muse" }),
      });
    expect((await refer()).res.status).toBe(201);
    expect((await refer()).res.status).toBe(429);
  });

  it("caps anonymous checkouts per offer per day", async () => {
    const h = track(harness({ ANON_CHECKOUTS_PER_OFFER_PER_DAY: "2" }));
    expect((await h.checkout()).res.status).toBe(201);
    expect((await h.checkout()).res.status).toBe(201);
    const third = await h.checkout();
    expect(third.res.status).toBe(429);
    expect(third.body.error.code).toBe("ANON_LIMIT");
    expect(
      (await h.checkout({ offer_id: OFFER, principal_ref: "named@example.com" })).res.status,
    ).toBe(201);
  });

  it("caps outstanding unused checkouts per offer", async () => {
    const h = track(harness({ MAX_OUTSTANDING_CHECKOUTS_PER_OFFER: "2" }));
    await h.checkout({ offer_id: OFFER, principal_ref: "a@example.com" });
    await h.checkout({ offer_id: OFFER, principal_ref: "b@example.com" });
    const third = await h.checkout({ offer_id: OFFER, principal_ref: "c@example.com" });
    expect(third.res.status).toBe(429);
    expect(third.body.error.code).toBe("OUTSTANDING_LIMIT");
  });

  it("issues short-lived tokens and stores the discount node id and a clear title", async () => {
    const h = track(harness());
    const shopify = fakeShopify();
    shopifyAdmin.fetch = shopify.fetch;
    h.bindShop();
    const { body } = await h.checkout();
    const ttl = (new Date(body.expires_at).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(29 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 60);
    const row = h.handle.db.select().from(tokens).where(eq(tokens.rawJws, body.token)).get();
    expect(row?.discountNodeId).toBe("gid://shopify/DiscountCodeNode/1");
    expect(row?.discountCode).toMatch(/^OL[0-9A-F]{12}$/);
    const input = shopify.calls[0].variables.basicCodeDiscount as { title: string; code: string };
    expect(input.title).toBe(`Offerlayer · agent checkout · ${OFFER}`);
    expect(input.code).toBe(row?.discountCode);
  });

  it("cleanup deletes expired unused codes only, and retries failures", async () => {
    const h = track(harness());
    const shopify = fakeShopify();
    shopifyAdmin.fetch = shopify.fetch;
    h.bindShop();
    const unused = await h.checkout({ offer_id: OFFER, principal_ref: "u@example.com" });
    const used = await h.checkout({ offer_id: OFFER, principal_ref: "p@example.com" });
    await h.webhook("orders/paid", {
      id: 501,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: used.body.token }],
    });

    // Not expired yet: nothing to delete.
    expect((await cleanupExpiredDiscounts(h.handle)).checked).toBe(0);

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    shopify.failDeletes.value = true;
    const failed = await cleanupExpiredDiscounts(h.handle, { now: later });
    expect(failed).toEqual({ checked: 1, deleted: 0, failed: 1 });
    const failedRow = h.handle.db
      .select()
      .from(tokens)
      .where(eq(tokens.rawJws, unused.body.token))
      .get();
    expect(failedRow?.discountCleanupError).toBe("Throttled");

    shopify.failDeletes.value = false;
    const ok = await cleanupExpiredDiscounts(h.handle, { now: later });
    expect(ok).toEqual({ checked: 1, deleted: 1, failed: 0 });
    const deletes = shopify.calls.filter((c) => c.query.includes("discountCodeDelete"));
    expect(deletes.at(-1)?.variables.id).toBe(failedRow?.discountNodeId);
    const usedRow = h.handle.db
      .select()
      .from(tokens)
      .where(eq(tokens.rawJws, used.body.token))
      .get();
    expect(usedRow?.discountDeletedAt).toBeNull();
    expect((await cleanupExpiredDiscounts(h.handle, { now: later })).checked).toBe(0);
  });

  it("the cleanup job route needs the internal key", async () => {
    const h = track(harness(PROD_SECRETS));
    const anon = await h.json("/v1/internal/jobs/cleanup-discounts", { method: "POST" });
    expect(anon.res.status).toBe(401);
    const ok = await h.json("/v1/internal/jobs/cleanup-discounts", {
      method: "POST",
      headers: { "x-internal-key": PROD_SECRETS.INTERNAL_API_KEY },
    });
    expect(ok.res.status).toBe(200);
    expect(ok.body).toEqual({ checked: 0, deleted: 0, failed: 0 });
  });
});

describe("§2.3 customer emails are hashed", () => {
  it("leaves no raw email anywhere in the database after a webhook", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    await h.webhook("orders/paid", {
      id: 601,
      total_price: "32.00",
      currency: "USD",
      email: "Private.Buyer@Example.com",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    const tables = h.handle.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const dump = JSON.stringify(
        h.handle.sqlite.prepare(`SELECT * FROM ${name}`).all(),
      ).toLowerCase();
      expect(dump, name).not.toContain("private.buyer");
    }
    const order = h.handle.sqlite.prepare("SELECT email_hash FROM orders_ext").get() as {
      email_hash: string;
    };
    expect(order.email_hash).toMatch(/^hmac:[0-9a-f]{64}$/);
  });

  it("a shopper capped by order email is capped by principal_ref too", async () => {
    const h = track(harness());
    const first = await h.checkout();
    await h.webhook("orders/paid", {
      id: 602,
      total_price: "32.00",
      currency: "USD",
      email: "Buyer@Example.com",
      note_attributes: [{ name: "agent_ref", value: first.body.token }],
    });
    const again = await h.checkout({ offer_id: OFFER, principal_ref: "  buyer@example.com " });
    expect(again.res.status).toBe(409);
    expect(again.body.error.code).toBe("CAP_EXCEEDED");
  });

  it("a shopper capped by principal_ref is capped when the email arrives by webhook", async () => {
    const h = track(harness());
    const first = await h.checkout({ offer_id: OFFER, principal_ref: "buyer@example.com" });
    await h.webhook("orders/paid", {
      id: 603,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: first.body.token }],
    });
    const anonToken = await h.checkout();
    const second = await h.webhook("orders/paid", {
      id: 604,
      total_price: "32.00",
      currency: "USD",
      email: "BUYER@example.com",
      note_attributes: [{ name: "agent_ref", value: anonToken.body.token }],
    });
    expect(second.body.ignored).toBe(true);
    expect(second.body.reason).toBe("CAP_EXCEEDED");
  });

  it("wipes raw emails left by older builds on migrate", () => {
    const h = track(harness());
    const issued = h.handle.sqlite.prepare("SELECT token_id FROM tokens").get() as
      { token_id: string } | undefined;
    const tokenId = issued?.token_id ?? "tok_legacy";
    if (!issued) {
      h.handle.sqlite
        .prepare(
          "INSERT INTO tokens (token_id, offer_id, agent_id, principal_hash, exp, nonce, raw_jws, created_at) VALUES (?, ?, 'agt_demo', 'anon', 0, 'legacynonce', 'olt_legacy', '2026-01-01')",
        )
        .run(tokenId, OFFER);
    }
    h.handle.sqlite
      .prepare(
        "INSERT INTO orders_ext (id, merchant_id, token_id, total, currency, email_hash, status, paid_at, hold_until) VALUES ('ord_legacy', 'mer_demo_towels', ?, '1.00', 'USD', 'raw@example.com', 'cleared', '2026-01-01', '2026-01-02')",
      )
      .run(tokenId);
    h.handle.sqlite
      .prepare(
        "INSERT INTO principals (id, merchant_id, email_hash, first_seen_at) VALUES ('prn_legacy', 'mer_demo_towels', 'raw@example.com', '2026-01-01')",
      )
      .run();
    migrate(h.handle.sqlite);
    const order = h.handle.sqlite
      .prepare("SELECT email_hash FROM orders_ext WHERE id = 'ord_legacy'")
      .get() as {
      email_hash: string | null;
    };
    expect(order.email_hash).toBeNull();
    expect(
      h.handle.sqlite.prepare("SELECT * FROM principals WHERE id = 'prn_legacy'").get(),
    ).toBeUndefined();
  });
});

describe("§2.4 secrets are separated", () => {
  it("encrypts access tokens with the encryption key, not the signing secret", () => {
    const h = track(harness());
    h.bindShop();
    const row = h.handle.sqlite
      .prepare("SELECT access_token_enc FROM merchants WHERE shop_domain = ?")
      .get(DEMO_SHOP) as {
      access_token_enc: string;
    };
    expect(decryptSecret(row.access_token_enc, h.env.accessTokenEncryptionKey)).toBe("shpat_test");
    expect(() => decryptSecret(row.access_token_enc, h.env.tokenSigningSecret)).toThrow();
  });
});

describe("§2.4 rotation", () => {
  it("keeps shops connected and in-flight tokens valid across a key rotation", async () => {
    const oldKeys = { ...PROD_SECRETS, DATABASE_URL: tempDb() };
    const before = track(harness(oldKeys));
    before.bindShop();
    const issued = await before.checkout({ offer_id: OFFER }, PROD_SECRETS.DEMO_AGENT_KEY);
    closeDatabase(before.handle);
    open.pop();

    const rotated = {
      ...oldKeys,
      TOKEN_SIGNING_SECRET: "sig_new_" + "9".repeat(40),
      TOKEN_SIGNING_SECRET_PREVIOUS: PROD_SECRETS.TOKEN_SIGNING_SECRET,
      ACCESS_TOKEN_ENCRYPTION_KEY: "enc_new_" + "9".repeat(40),
      ACCESS_TOKEN_ENCRYPTION_KEY_PREVIOUS: PROD_SECRETS.ACCESS_TOKEN_ENCRYPTION_KEY,
    };
    const after = track(harness(rotated));
    const shopify = fakeShopify();
    shopifyAdmin.fetch = shopify.fetch;
    // Old ciphertext still decrypts, so minting a code still reaches Shopify.
    expect(
      (
        await after.checkout(
          { offer_id: OFFER, principal_ref: "r@example.com" },
          PROD_SECRETS.DEMO_AGENT_KEY,
        )
      ).res.status,
    ).toBe(201);
    expect(shopify.calls).toHaveLength(1);
    // A token signed with the old secret still attributes.
    const paid = await after.webhook("orders/paid", {
      id: 801,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    expect(paid.body.conversion.status).toBe("pending_hold");
  });
});

describe("§2.5 Shopify webhook hardening", () => {
  it("rejects a token from another shop and leaves it unspent", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    const order = {
      id: 701,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    };
    const wrong = await h.webhook("orders/paid", order, { shop: "other-store.myshopify.com" });
    expect(wrong.res.status).toBe(200);
    expect(wrong.body).toMatchObject({ ignored: true, reason: "SHOP_MISMATCH" });
    const missing = await h.webhook("orders/paid", order, { shop: null });
    expect(missing.body).toMatchObject({ ignored: true, reason: "SHOP_DOMAIN_MISSING" });
    const right = await h.webhook("orders/paid", order);
    expect(right.body.conversion.status).toBe("pending_hold");
  });

  it("is idempotent on X-Shopify-Webhook-Id", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    const order = {
      id: 702,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    };
    const first = await h.webhook("orders/paid", order, { webhookId: "wh-1" });
    const replay = await h.webhook("orders/paid", order, { webhookId: "wh-1" });
    expect(first.body.conversion.status).toBe("pending_hold");
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.conversion.status).toBe("pending_hold");
    const n = h.handle.sqlite.prepare("SELECT count(*) AS n FROM orders_ext").get() as {
      n: number;
    };
    expect(n.n).toBe(1);
  });

  it("never double-counts a token, even if called twice directly", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    recordPaidOrder(h.handle, { token: issued.body.token, orderTotal: "32.00", currency: "USD" });
    expect(() =>
      recordPaidOrder(h.handle, { token: issued.body.token, orderTotal: "32.00", currency: "USD" }),
    ).toThrow(/already converted/);
    const tokenId = (
      h.handle.sqlite.prepare("SELECT token_id FROM orders_ext").get() as { token_id: string }
    ).token_id;
    expect(() =>
      h.handle.sqlite
        .prepare(
          "INSERT INTO orders_ext (id, merchant_id, token_id, total, currency, status, paid_at, hold_until) VALUES ('ord_dup', 'mer_demo_towels', ?, '1.00', 'USD', 'pending_hold', 'x', 'y')",
        )
        .run(tokenId),
    ).toThrow(/UNIQUE/);
  });

  it("attributes only the line items the offer covers", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    const { body } = await h.webhook("orders/paid", {
      id: 703,
      total_price: "112.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
      line_items: [
        {
          id: 1,
          product_id: 1001,
          variant_id: 5001,
          price: "32.00",
          quantity: 2,
          discount_allocations: [{ amount: "6.40", discount_application_index: 0 }],
        },
        {
          id: 2,
          product_id: 2002,
          variant_id: 6002,
          price: "48.00",
          quantity: 1,
          discount_allocations: [],
        },
      ],
    });
    expect(body.conversion.order_total).toBe("57.60");
    const row = h.handle.sqlite.prepare("SELECT total, order_total FROM orders_ext").get() as {
      total: string;
      order_total: string;
    };
    expect(row).toEqual({ total: "57.60", order_total: "112.00" });
  });

  it("uses the lines our discount code was allocated to when present", async () => {
    const h = track(harness());
    const shopify = fakeShopify();
    shopifyAdmin.fetch = shopify.fetch;
    h.bindShop();
    const issued = await h.checkout();
    const code = h.handle.db
      .select()
      .from(tokens)
      .where(eq(tokens.rawJws, issued.body.token))
      .get()?.discountCode;
    const { body } = await h.webhook("orders/paid", {
      id: 704,
      total_price: "70.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
      discount_applications: [
        { type: "discount_code", code: "WELCOME5" },
        { type: "discount_code", code },
      ],
      line_items: [
        // Different product id, but our code was allocated here (e.g. a collection offer).
        {
          id: 11,
          product_id: 9999,
          price: "40.00",
          quantity: 1,
          discount_allocations: [{ amount: "4.00", discount_application_index: 1 }],
        },
        {
          id: 12,
          product_id: 1001,
          price: "30.00",
          quantity: 1,
          discount_allocations: [{ amount: "5.00", discount_application_index: 0 }],
        },
      ],
    });
    expect(body.conversion.order_total).toBe("36.00");
  });

  it("accepts a paid order whose token expired after checkout", async () => {
    const h = track(harness({ CHECKOUT_TTL_SECONDS: "1" }));
    const issued = await h.checkout();
    await new Promise((r) => setTimeout(r, 1100));
    const { body } = await h.webhook("orders/paid", {
      id: 705,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    expect(body.conversion.status).toBe("pending_hold");
  });

  it("handles partial refunds proportionally and full refunds as clawback", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    await h.webhook("orders/paid", {
      id: 706,
      total_price: "100.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
      line_items: [
        { id: 21, product_id: 1001, price: "30.00", quantity: 2, discount_allocations: [] },
        { id: 22, product_id: 3003, price: "40.00", quantity: 1, discount_allocations: [] },
      ],
    });
    // Refund one towel (attributed) and the unrelated item.
    const partial = await h.webhook("refunds/create", {
      id: 9001,
      order_id: 706,
      refund_line_items: [
        { line_item_id: 21, quantity: 1, subtotal: "30.00" },
        { line_item_id: 22, quantity: 1, subtotal: "40.00" },
      ],
    });
    expect(partial.body.conversion.status).toBe("pending_hold");
    expect(partial.body.conversion.reward_amount).toBe("3.00"); // 10% of the remaining 30.00
    const replay = await h.webhook("refunds/create", {
      id: 9001,
      order_id: 706,
      refund_line_items: [{ line_item_id: 21, quantity: 1, subtotal: "30.00" }],
    });
    expect(replay.body.conversion.status).toBe("pending_hold");
    const mid = h.handle.sqlite.prepare("SELECT refunded_total FROM orders_ext").get() as {
      refunded_total: string;
    };
    expect(mid.refunded_total).toBe("30.00");

    const rest = await h.webhook("refunds/create", {
      id: 9002,
      order_id: 706,
      refund_line_items: [{ line_item_id: 21, quantity: 1, subtotal: "30.00" }],
    });
    expect(rest.body.conversion.status).toBe("clawed_back");
  });

  it("prorates amount-only refunds by the attributed share", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    await h.webhook("orders/paid", {
      id: 707,
      total_price: "100.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
      line_items: [
        { id: 31, product_id: 1001, price: "25.00", quantity: 1, discount_allocations: [] },
        { id: 32, product_id: 4004, price: "75.00", quantity: 1, discount_allocations: [] },
      ],
    });
    await h.webhook("refunds/create", {
      id: 9101,
      order_id: 707,
      refund_line_items: [],
      transactions: [{ kind: "refund", status: "success", amount: "20.00" }],
    });
    const row = h.handle.sqlite.prepare("SELECT refunded_total, status FROM orders_ext").get() as {
      refunded_total: string;
      status: string;
    };
    expect(row).toEqual({ refunded_total: "5.00", status: "pending_hold" });
  });

  it("ignores refunds sent from a different shop", async () => {
    const h = track(harness());
    const issued = await h.checkout();
    await h.webhook("orders/paid", {
      id: 708,
      total_price: "32.00",
      currency: "USD",
      note_attributes: [{ name: "agent_ref", value: issued.body.token }],
    });
    const { body } = await h.webhook(
      "orders/cancelled",
      { id: 708 },
      { shop: "other-store.myshopify.com" },
    );
    expect(body).toMatchObject({ ignored: true, reason: "SHOP_MISMATCH" });
  });
});

describe("§2.6 database TLS", () => {
  it("verifies the server certificate", () => {
    expect(pgSslConfig("postgres://u:p@db.example.com/x?sslmode=require")).toMatchObject({
      rejectUnauthorized: true,
    });
    expect(pgSslConfig("postgres://u:p@localhost/x")).toBeUndefined();
  });
});

describe("§2.7 limits are enforced at checkout time", () => {
  async function sellerOffer(h: ReturnType<typeof harness>, caps: Record<string, unknown> = {}) {
    const seller = {
      "content-type": "application/json",
      authorization: `Bearer ${h.keys.sellerAgentKey}`,
    };
    const mandate = async (c: Record<string, unknown>) => {
      const proposed = await h.json("/v1/seller/mandates", {
        method: "POST",
        headers: seller,
        body: JSON.stringify({
          shop_domain: DEMO_SHOP,
          selector: { type: "shop" },
          caps: {
            max_reward_flat: "50.00",
            max_reward_percent: "20",
            max_finder_fee_flat: "20.00",
            max_finder_fee_percent: "20",
            max_daily_liability: "500.00",
            max_clawback_days: 30,
            ...c,
          },
        }),
      });
      await h.json(`/v1/seller/mandates/${proposed.body.id}/activate`, {
        method: "POST",
        headers: seller,
        body: JSON.stringify({ human_confirmed: true }),
      });
      return proposed.body.id as string;
    };
    const mandateId = await mandate(caps);
    const offer = await h.json("/v1/seller/offers", {
      method: "POST",
      headers: seller,
      body: JSON.stringify({
        shop_domain: DEMO_SHOP,
        status: "live",
        selector: {
          type: "product",
          ids: ["gid://shopify/Product/1001"],
          title: "Towels",
          list_price: "40.00",
          currency: "USD",
        },
        reward: { type: "percent", amount: "15", currency: "USD", recipient: "buyer" },
        constraints: { clawback_days: 14 },
      }),
    });
    expect(offer.res.status).toBe(201);
    return { offerId: offer.body.id as string, mandateId, mandate, seller };
  }

  it("stops checkouts once the mandate is revoked", async () => {
    const h = track(harness());
    const { offerId, mandateId, seller } = await sellerOffer(h);
    expect((await h.checkout({ offer_id: offerId })).res.status).toBe(201);
    await h.json(`/v1/seller/mandates/${mandateId}/revoke`, { method: "POST", headers: seller });
    const after = await h.checkout({ offer_id: offerId });
    expect(after.res.status).toBe(409);
    expect(after.body.error.code).toBe("OFFER_UNAVAILABLE");
  });

  it("applies a lowered discount cap to an existing offer immediately", async () => {
    const h = track(harness());
    const { offerId, mandate } = await sellerOffer(h);
    await mandate({ max_reward_percent: "10" });
    const after = await h.checkout({ offer_id: offerId });
    expect(after.res.status).toBe(409);
    expect(after.body.error.code).toBe("OFFER_UNAVAILABLE");
  });

  it("stops minting when the daily budget would be exceeded", async () => {
    // Worst case per checkout is 15% of 40.00 = 6.00, so 20.00 covers three.
    const h = track(harness());
    const { offerId } = await sellerOffer(h, { max_daily_liability: "20.00" });
    for (let i = 0; i < 3; i++) {
      expect(
        (await h.checkout({ offer_id: offerId, principal_ref: `b${i}@example.com` })).res.status,
      ).toBe(201);
    }
    const over = await h.checkout({ offer_id: offerId, principal_ref: "b4@example.com" });
    expect(over.res.status).toBe(409);
    expect(over.body.error.code).toBe("BUDGET_EXHAUSTED");
  });
});
