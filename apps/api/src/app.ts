import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import {
  checkoutRequestSchema,
  compareMoney,
  newId,
  referRequestSchema,
  simulateClearSchema,
  simulatePurchaseSchema,
  upsertOfferSchema,
} from "@offerlayer/schema";
import { agents, eq, merchants, offers, rowToOffer, REPO_ROOT, type DbHandle } from "@offerlayer/db";
import {
  clearHold,
  conversionForToken,
  issueCheckout,
  loadOffer,
  lookupAgentByKey,
  recordPaidOrder,
} from "./conversion-machine.ts";
import { ApiError, jsonError } from "./errors.ts";
import { logJson } from "./logger.ts";
import { handleShopifyWebhook } from "./webhooks.ts";
import { registerSellerRoutes } from "./seller.ts";
import { registerShopifyAuthRoutes } from "./shopify-auth.ts";
import { VERSION } from "./version.ts";
import { isLoopbackHost, requestPublicOrigin } from "./origin.ts";

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ");
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return value;
}

function timingEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function createApp(handle: DbHandle) {
  const app = new Hono();
  const playgroundAuth = new WeakMap<object, { authorization: string; demo: string }>();

  app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type", "x-demo-key", "x-internal-key"] }));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json({ error: { code: "INVALID_BODY", message: err.message } }, 400);
    }
    logJson({
      level: "error",
      msg: "unhandled_hono",
      error: err instanceof Error ? err.message : "unknown",
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json(
      {
        error: {
          code: "INTERNAL",
          message: err instanceof Error ? err.message : "Internal error",
        },
      },
      500,
    );
  });

  app.use("*", async (c, next) => {
    const mode = c.req.header("x-offerlayer-playground");
    if (mode === "shopper" || mode === "seller") {
      const key = mode === "shopper" ? handle.env.demoAgentKey : handle.env.sellerAgentKey;
      if (key && handle.env.demoKey) {
        playgroundAuth.set(c.req.raw, { authorization: `Bearer ${key}`, demo: handle.env.demoKey });
      }
    }
    await next();
  });

  const hdr = (
    c: { req: { header: (n: string) => string | undefined; raw?: object } },
    name: string,
  ): string | undefined => {
    const injected = c.req.raw ? playgroundAuth.get(c.req.raw) : undefined;
    const sent = c.req.header(name);
    if (sent) return sent;
    if (name === "authorization") return injected?.authorization;
    if (name === "x-demo-key") return injected?.demo;
    return undefined;
  };

  const requireAgent = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const key = bearer(hdr(c, "authorization"));
    if (!key) throw jsonError("UNAUTHORIZED", "Missing agent bearer token", 401);
    const agent = lookupAgentByKey(handle, key);
    if (!agent) throw jsonError("UNAUTHORIZED", "Invalid agent key", 401);
    return agent;
  };

  const requireShopper = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const agent = await requireAgent(c);
    if (agent.role === "seller") {
      throw jsonError("ROLE_MISMATCH", "Seller keys cannot attach checkouts", 403);
    }
    return agent;
  };

  const requireSeller = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const agent = await requireAgent(c);
    if (agent.role !== "seller") {
      throw jsonError("ROLE_MISMATCH", "Shopper keys cannot manage seller shops", 403);
    }
    return agent;
  };

  const requireDemoOrAgent = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const demo = hdr(c, "x-demo-key");
    if (demo && timingEqual(demo, handle.env.demoKey)) return { id: "agt_demo", role: "shopper", demo: true };
    return requireShopper(c);
  };

  const requireDemoOrInternal = (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const demo = hdr(c, "x-demo-key");
    const internal = c.req.header("x-internal-key") ?? bearer(hdr(c, "authorization"));
    if (demo && timingEqual(demo, handle.env.demoKey)) return;
    if (internal && timingEqual(internal, handle.env.internalApiKey)) return;
    throw jsonError("UNAUTHORIZED", "Demo or internal key required", 401);
  };

  const requireSellerOrDemoOrInternal = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const demo = hdr(c, "x-demo-key");
    if (demo && timingEqual(demo, handle.env.demoKey)) return { id: "demo", role: "internal" };
    const internal = c.req.header("x-internal-key");
    if (internal && timingEqual(internal, handle.env.internalApiKey)) {
      return { id: "internal", role: "internal" };
    }
    const authz = bearer(hdr(c, "authorization"));
    if (authz && timingEqual(authz, handle.env.internalApiKey)) {
      return { id: "internal", role: "internal" };
    }
    return requireSeller(c);
  };

  const requireDemoAndSeller = async (c: {
    req: { header: (n: string) => string | undefined; raw?: object };
  }) => {
    const demo = hdr(c, "x-demo-key");
    if (!demo || !timingEqual(demo, handle.env.demoKey)) {
      throw jsonError("UNAUTHORIZED", "Demo key required", 401);
    }
    return requireSeller(c);
  };

  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: VERSION,
      shopify_oauth: Boolean(handle.env.shopifyApiKey),
    }),
  );

  registerShopifyAuthRoutes(app, handle);

  app.get("/v1/seller/me", async (c) => {
    const seller = await requireSeller(c);
    const origin = requestPublicOrigin(c.req, handle.env);
    return c.json({
      agent_id: seller.id,
      role: seller.role,
      name: seller.name,
      shopify_oauth: Boolean(handle.env.shopifyApiKey),
      app_url: isLoopbackHost(origin) ? "https://offerlayer.grok.me" : origin,
      redirect_uri: `${isLoopbackHost(origin) ? "https://offerlayer.grok.me" : origin}/auth/callback`,
      webhook_uri: `${isLoopbackHost(origin) ? "https://offerlayer.grok.me" : origin}/v1/webhooks/shopify`,
    });
  });

  app.get("/.well-known/agent-offers.json", (c) => {
    const shop = c.req.query("shop") ?? hostShop(c.req.header("host"));
    const list = listOffers(handle, { shop: shop ?? undefined, limit: 50 });
    return c.json({ protocol: "offerlayer/0.1", offers: list });
  });

  app.get("/v1/offers", (c) => {
    const q = c.req.query("q") ?? undefined;
    const shipTo = c.req.query("ship_to") ?? undefined;
    const maxPrice = c.req.query("max_price") ?? undefined;
    const shop = c.req.query("shop") ?? undefined;
    const productId = c.req.query("product_id") ?? undefined;
    const limitRaw = Number(c.req.query("limit") ?? "20");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const offersList = listOffers(handle, { q, shipTo, maxPrice, shop, productId, limit });
    return c.json({ offers: offersList });
  });

  app.get("/v1/offers/:id", (c) => {
    const { offer } = loadOffer(handle, c.req.param("id"));
    if (offer.status !== "live") {
      throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
    }
    return c.json(offer);
  });

  app.post("/v1/checkouts", async (c) => {
    const agent = await requireShopper(c);
    const body = checkoutRequestSchema.parse(await c.req.json());
    const result = await issueCheckout(handle, {
      offerId: body.offer_id,
      agentId: agent.id,
      principalRef: body.principal_ref,
    });
    logJson({ level: "info", msg: "checkout_issued", offer_id: body.offer_id, agent_id: agent.id });
    return c.json(result, 201);
  });

  app.post("/v1/refer", async (c) => {
    const agent = await requireShopper(c);
    const body = referRequestSchema.parse(await c.req.json());
    if (body.to_agent_id) {
      const dest = handle.db.select().from(agents).where(eq(agents.id, body.to_agent_id)).get();
      if (!dest) throw jsonError("AGENT_NOT_FOUND", "to_agent_id not found", 404);
    }
    const presenting = body.to_agent_id ?? agent.id;
    const result = await issueCheckout(handle, {
      offerId: body.offer_id,
      agentId: presenting,
      referrerAgentId: agent.id,
    });
    return c.json(result, 201);
  });

  app.get("/v1/conversions/:token{.+}", async (c) => {
    await requireShopper(c);
    const token = c.req.param("token");
    return c.json(conversionForToken(handle, token));
  });

  app.post("/v1/simulate/purchase", async (c) => {
    await requireDemoOrAgent(c);
    const body = simulatePurchaseSchema.parse(await c.req.json());
    const conversion = recordPaidOrder(handle, {
      token: body.token,
      orderTotal: body.order_total,
      currency: body.currency,
      emailHash: body.email_hash,
    });
    return c.json(conversion, 201);
  });

  app.post("/v1/simulate/clear", async (c) => {
    requireDemoOrInternal(c);
    const body = simulateClearSchema.parse(await c.req.json());
    return c.json(clearHold(handle, body.token));
  });

  app.post("/v1/webhooks/shopify", async (c) => {
    const raw = await c.req.text();
    const hmac = c.req.header("x-shopify-hmac-sha256") ?? undefined;
    const topic = c.req.header("x-shopify-topic") ?? "";
    const result = handleShopifyWebhook(handle, { topic, rawBody: raw, hmac });
    return c.json(result);
  });

  app.post("/v1/internal/offers", async (c) => {
    requireDemoOrInternal(c);
    const body = upsertOfferSchema.parse(await c.req.json());
    const saved = upsertOffer(handle, body);
    return c.json(saved, 201);
  });

  app.get("/v1/internal/seed", (c) => {
    requireDemoOrInternal(c);
    return c.json({
      demo_agent_id: "agt_demo",
      muse_agent_id: "agt_muse",
      offer_id: "off_towel_organic_set",
      shop: "demo-towels.myshopify.com",
      seller_agent_id: "agt_seller",
    });
  });

  registerSellerRoutes(app, handle, {
    requireSeller,
    requireSellerOrDemoOrInternal,
    requireDemoAndSeller,
  });

  try {
    const openapi = readFileSync(join(REPO_ROOT, "protocol/openapi.yaml"), "utf8");
    app.get("/openapi.yaml", (c) => {
      c.header("content-type", "text/yaml; charset=utf-8");
      return c.body(openapi);
    });
  } catch {
    // protocol file optional in isolated tests
  }

  return app;
}

function hostShop(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.split(":")[0] ?? host;
  if (h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0") return null;
  return h;
}

export function listOffers(
  handle: DbHandle,
  filters: {
    q?: string;
    shipTo?: string;
    maxPrice?: string;
    shop?: string;
    productId?: string;
    limit: number;
  },
) {
  const rows = handle.db.select().from(offers).where(eq(offers.status, "live")).all();
  const out = [];
  for (const row of rows) {
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
    if (!merchant) continue;
    if (filters.shop && merchant.shopDomain !== filters.shop) continue;
    const offer = rowToOffer(row, merchant);
    if (filters.q) {
      const hay = `${offer.selector.title ?? ""} ${offer.disclosure} ${offer.id} ${merchant.name}`.toLowerCase();
      if (!hay.includes(filters.q.toLowerCase())) continue;
    }
    if (filters.shipTo) {
      const allowed = offer.constraints.ship_to;
      if (allowed && allowed.length > 0 && !allowed.includes(filters.shipTo.toUpperCase())) continue;
    }
    if (filters.maxPrice && offer.selector.list_price) {
      if (compareMoney(offer.selector.list_price, filters.maxPrice) > 0) continue;
    }
    if (filters.productId) {
      const ids = offer.selector.ids ?? [];
      if (!ids.includes(filters.productId) && !ids.some((id) => id.endsWith(`/${filters.productId}`))) {
        continue;
      }
    }
    out.push(offer);
    if (out.length >= filters.limit) break;
  }
  return out;
}

function upsertOffer(handle: DbHandle, body: ReturnType<typeof upsertOfferSchema.parse>) {
  const now = new Date().toISOString();
  let merchant = handle.db
    .select()
    .from(merchants)
    .where(eq(merchants.shopDomain, body.shop_domain))
    .get();
  if (!merchant) {
    handle.db
      .insert(merchants)
      .values({
        id: newId("mer_"),
        shopDomain: body.shop_domain,
        shopifyShopId: null,
        accessTokenEnc: null,
        name: body.merchant_name ?? body.shop_domain,
        website: body.website ?? `https://${body.shop_domain}`,
        createdAt: now,
      })
      .run();
    merchant = handle.db
      .select()
      .from(merchants)
      .where(eq(merchants.shopDomain, body.shop_domain))
      .get();
  }
  if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Failed to upsert merchant", 500);
  const id = body.id ?? newId("off_");
  const existing = handle.db.select().from(offers).where(eq(offers.id, id)).get();
  const values = {
    id,
    merchantId: merchant.id,
    status: body.status,
    selectorType: body.selector.type,
    selectorIdsJson: JSON.stringify(body.selector.ids ?? []),
    selectorTitle: body.selector.title ?? null,
    listPrice: body.selector.list_price ?? null,
    selectorCurrency: body.selector.currency ?? null,
    rewardType: body.reward.type,
    rewardAmount: body.reward.amount,
    rewardCurrency: body.reward.currency,
    rewardRecipient: "buyer",
    finderFeeType: body.finder_fee?.type ?? null,
    finderFeeAmount: body.finder_fee?.amount ?? null,
    finderFeeCurrency: body.finder_fee?.currency ?? null,
    finderFeeRecipient: body.finder_fee ? "agent" : null,
    newCustomerOnly: body.constraints.new_customer_only ? 1 : 0,
    shipToJson: JSON.stringify(body.constraints.ship_to ?? []),
    maxPerPrincipalPerDay: body.constraints.max_per_principal_per_day ?? null,
    maxUnitsPerOrder: body.constraints.max_units_per_order ?? null,
    clawbackDays: body.constraints.clawback_days,
    disclosure: body.disclosure,
    checkoutUrlTemplate: body.checkout.tracked_url_template,
    ucp: body.checkout.ucp ? 1 : 0,
    updatedAt: now,
  };
  if (existing) {
    handle.db.update(offers).set(values).where(eq(offers.id, id)).run();
  } else {
    handle.db.insert(offers).values({ ...values, createdAt: now }).run();
  }
  const { offer } = loadOffer(handle, id);
  return offer;
}
