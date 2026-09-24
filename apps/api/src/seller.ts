import type { Hono } from "hono";
import {
  addMoney,
  computePayout,
  newId,
  newNonce,
  normalizeMoney,
  proposeMandateSchema,
  sellerCompleteLinkSchema,
  sellerCreateOfferSchema,
  sellerLinkRequestSchema,
  sellerPatchOfferSchema,
  simulateConnectShopSchema,
  simulateShopifyOauthSchema,
  type SellerCreateOfferInput,
} from "@offerlayer/schema";
import {
  and,
  eq,
  inArray,
  mandates,
  merchants,
  offers,
  ordersExt,
  rowToOffer,
  sellerLinks,
  shopGrants,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { jsonError } from "./errors.ts";
import { requestPublicOrigin } from "./origin.ts";
import {
  activateMandate,
  proposeMandate,
  requireMandateForWrite,
  revokeMandate,
  rowToMandate,
  type MandateWrite,
} from "./mandate.ts";
import {
  decryptAccessToken,
  encryptAccessToken,
  fetchShopProducts,
  FIXTURE_CATALOG_PRODUCTS,
  normalizeShopDomain,
  parseCatalogJson,
  registerWebhooks,
  trackedCartUrl,
  withCheckoutTemplate,
  type CatalogProduct,
} from "./shopify-admin.ts";

const INSTALL_DISCLOSURE =
  "Your human must approve this Shopify install. You cannot publish offers until they do. There is no agent-only install.";

type AgentRow = { id: string; role: string; name?: string };

type AuthFns = {
  requireSeller: (c: { req: { header: (n: string) => string | undefined } }) => Promise<AgentRow>;
  requireSellerOrDemoOrInternal: (c: {
    req: { header: (n: string) => string | undefined };
  }) => Promise<{ id: string; role: string }>;
  requireDemoAndSeller: (c: { req: { header: (n: string) => string | undefined } }) => Promise<AgentRow>;
};

function tryNormalizeShop(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return normalizeShopDomain(raw);
  } catch {
    return raw.trim().toLowerCase() || null;
  }
}

function linkUrls(origin: string, linkId: string, shop: string | null) {
  const qs = new URLSearchParams({ seller_link: linkId });
  if (shop) qs.set("shop", shop);
  return {
    install_url: `${origin}/auth/login?${qs.toString()}`,
    demo_complete_url: `${origin}/v1/seller/links/${linkId}/complete`,
  };
}

function findMerchant(handle: DbHandle, idOrDomain: string) {
  const byId = handle.db.select().from(merchants).where(eq(merchants.id, idOrDomain)).get();
  if (byId) return byId;
  const shop = tryNormalizeShop(idOrDomain) ?? idOrDomain;
  return handle.db.select().from(merchants).where(eq(merchants.shopDomain, shop)).get();
}

function activeGrant(handle: DbHandle, sellerAgentId: string, merchantId: string) {
  return handle.db
    .select()
    .from(shopGrants)
    .where(
      and(
        eq(shopGrants.sellerAgentId, sellerAgentId),
        eq(shopGrants.merchantId, merchantId),
        eq(shopGrants.status, "active"),
      ),
    )
    .get();
}

function requireGrant(handle: DbHandle, sellerAgentId: string, merchantId: string) {
  const grant = activeGrant(handle, sellerAgentId, merchantId);
  if (!grant) throw jsonError("FORBIDDEN", "Seller does not hold a grant on this shop", 403);
  return grant;
}

function upsertMerchant(
  handle: DbHandle,
  shop: string,
  extra: {
    name?: string | null;
    shopifyShopId?: string | null;
    accessTokenEnc?: string | null;
    catalogJson?: string | null;
  } = {},
) {
  const now = new Date().toISOString();
  let merchant = handle.db.select().from(merchants).where(eq(merchants.shopDomain, shop)).get();
  if (!merchant) {
    const id = newId("mer_");
    handle.db
      .insert(merchants)
      .values({
        id,
        shopDomain: shop,
        shopifyShopId: extra.shopifyShopId ?? null,
        accessTokenEnc: extra.accessTokenEnc ?? null,
        name: extra.name || shop,
        website: `https://${shop}`,
        catalogJson: extra.catalogJson ?? null,
        createdAt: now,
      })
      .run();
    merchant = handle.db.select().from(merchants).where(eq(merchants.id, id)).get();
  } else {
    const patch: Record<string, string | null> = {
      ...(extra.name ? { name: extra.name } : {}),
      ...(extra.shopifyShopId ? { shopifyShopId: extra.shopifyShopId } : {}),
      ...(extra.accessTokenEnc !== undefined ? { accessTokenEnc: extra.accessTokenEnc } : {}),
      ...(extra.catalogJson !== undefined ? { catalogJson: extra.catalogJson } : {}),
    };
    if (Object.keys(patch).length > 0) {
      handle.db.update(merchants).set(patch).where(eq(merchants.id, merchant.id)).run();
      merchant = handle.db.select().from(merchants).where(eq(merchants.id, merchant.id)).get();
    }
  }
  if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Failed to upsert merchant", 500);
  return merchant;
}

function ensureGrant(handle: DbHandle, merchantId: string, sellerAgentId: string) {
  const existing = handle.db
    .select()
    .from(shopGrants)
    .where(and(eq(shopGrants.merchantId, merchantId), eq(shopGrants.sellerAgentId, sellerAgentId)))
    .get();
  if (existing) {
    if (existing.status !== "active") {
      handle.db.update(shopGrants).set({ status: "active" }).where(eq(shopGrants.id, existing.id)).run();
    }
    return existing.id;
  }
  const id = newId("grn_");
  handle.db
    .insert(shopGrants)
    .values({
      id,
      merchantId,
      sellerAgentId,
      status: "active",
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

export function completeLink(
  handle: DbHandle,
  linkId: string,
  shopRaw: string,
  extra: {
    shopifyShopId?: string | null;
    accessToken?: string | null;
    name?: string | null;
    catalog?: Omit<CatalogProduct, "checkout_template">[] | null;
  } = {},
) {
  const link = handle.db.select().from(sellerLinks).where(eq(sellerLinks.id, linkId)).get();
  if (!link) throw jsonError("LINK_NOT_FOUND", "Seller link not found", 404);
  const shop = tryNormalizeShop(shopRaw) ?? shopRaw;
  const accessTokenEnc = extra.accessToken
    ? encryptAccessToken(extra.accessToken, handle.env.tokenSecret)
    : undefined;
  const catalogJson = extra.catalog ? JSON.stringify(extra.catalog) : undefined;
  const merchant = upsertMerchant(handle, shop, {
    name: extra.name,
    shopifyShopId: extra.shopifyShopId,
    accessTokenEnc,
    catalogJson,
  });
  ensureGrant(handle, merchant.id, link.sellerAgentId);
  handle.db
    .update(sellerLinks)
    .set({
      status: "connected",
      shopDomain: shop,
      merchantId: merchant.id,
    })
    .where(eq(sellerLinks.id, link.id))
    .run();
  const bound = handle.db.select().from(merchants).where(eq(merchants.id, merchant.id)).get();
  return {
    status: "connected" as const,
    pending_link_id: link.id,
    shop_domain: shop,
    merchant_id: merchant.id,
    oauth_bound: Boolean(bound?.accessTokenEnc),
  };
}

function defaultDisclosure(
  shopName: string,
  reward: { type: string; amount: string },
  finderFee?: { type: string; amount: string } | null,
): string {
  const rewardText = reward.type === "percent" ? `${reward.amount}%` : `$${normalizeMoney(reward.amount)}`;
  if (!finderFee?.amount || finderFee.amount === "0") {
    return `${shopName} funds a ${rewardText} discount on this order if you buy through an AI agent. Nothing is paid just for showing it.`;
  }
  const feeText =
    finderFee.type === "percent" ? `${finderFee.amount}%` : `$${normalizeMoney(finderFee.amount)}`;
  return `${shopName} funds a ${rewardText} credit on this order if you buy through this Offerlayer offer. Optional agent finder fee: ${feeText}.`;
}

function checkoutTemplateFor(shop: string, ids: string[] | undefined, explicit?: string): string {
  if (explicit) return explicit;
  const variant = (ids ?? []).find((id) => /\/ProductVariant\//i.test(id));
  const cartId = variant ?? ids?.[0] ?? "1";
  return trackedCartUrl(shop, cartId);
}

function toSellerOffer(handle: DbHandle, offerId: string) {
  const row = handle.db.select().from(offers).where(eq(offers.id, offerId)).get();
  if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
  const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
  if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for offer", 500);
  return { ...rowToOffer(row, merchant), mandate_id: row.mandateId };
}

function writeFromCreate(body: SellerCreateOfferInput): MandateWrite {
  return {
    selectorType: body.selector.type,
    selectorIds: body.selector.ids ?? [],
    rewardType: body.reward.type,
    rewardAmount: body.reward.amount,
    finderFeeType: body.finder_fee?.type ?? null,
    finderFeeAmount: body.finder_fee?.amount ?? null,
    clawbackDays: body.constraints.clawback_days,
    listPrice: body.selector.list_price ?? null,
    action: "publish",
  };
}

function emptyBucket() {
  return { count: 0, gmv: "0.00", reward: "0.00", finder_fee: "0.00" };
}

export function registerSellerRoutes(app: Hono, handle: DbHandle, auth: AuthFns) {
  app.post("/v1/seller/links", async (c) => {
    const seller = await auth.requireSeller(c);
    const body = sellerLinkRequestSchema.parse(await c.req.json().catch(() => ({})));
    const shop = tryNormalizeShop(body.shop_domain);
    const now = new Date();
    const id = newId("lnk_");
    const origin = requestPublicOrigin(c.req, handle.env);
    const urls = linkUrls(origin, id, shop);
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    handle.db
      .insert(sellerLinks)
      .values({
        id,
        sellerAgentId: seller.id,
        shopDomain: shop,
        status: "pending",
        installUrl: urls.install_url,
        nonce: newNonce(),
        expiresAt,
        merchantId: null,
        createdAt: now.toISOString(),
      })
      .run();
    return c.json(
      {
        pending_link_id: id,
        install_url: urls.install_url,
        demo_complete_url: urls.demo_complete_url,
        expires_at: expiresAt,
        disclosure: INSTALL_DISCLOSURE,
        shop_domain: shop,
        status: "pending",
      },
      201,
    );
  });

  app.get("/v1/seller/links/:id", async (c) => {
    const seller = await auth.requireSeller(c);
    const id = c.req.param("id");
    const link = handle.db.select().from(sellerLinks).where(eq(sellerLinks.id, id)).get();
    if (!link || link.sellerAgentId !== seller.id) {
      throw jsonError("LINK_NOT_FOUND", "Seller link not found", 404);
    }
    const origin = requestPublicOrigin(c.req, handle.env);
    const urls = linkUrls(origin, link.id, link.shopDomain);
    return c.json({
      pending_link_id: link.id,
      status: link.status,
      shop_domain: link.shopDomain,
      merchant_id: link.merchantId,
      install_url: urls.install_url,
      demo_complete_url: urls.demo_complete_url,
      expires_at: link.expiresAt,
      disclosure: INSTALL_DISCLOSURE,
    });
  });

  app.post("/v1/seller/links/:id/complete", async (c) => {
    const actor = await auth.requireSellerOrDemoOrInternal(c);
    const id = c.req.param("id");
    const body = sellerCompleteLinkSchema.parse(await c.req.json());
    const link = handle.db.select().from(sellerLinks).where(eq(sellerLinks.id, id)).get();
    if (!link) throw jsonError("LINK_NOT_FOUND", "Seller link not found", 404);
    if (actor.role === "seller" && actor.id !== link.sellerAgentId) {
      throw jsonError("FORBIDDEN", "Only the creating seller can complete this link", 403);
    }
    return c.json(completeLink(handle, id, body.shop_domain));
  });

  app.get("/v1/seller/shops", async (c) => {
    const seller = await auth.requireSeller(c);
    const grants = handle.db
      .select()
      .from(shopGrants)
      .where(and(eq(shopGrants.sellerAgentId, seller.id), eq(shopGrants.status, "active")))
      .all();
    const shops = [];
    for (const grant of grants) {
      const merchant = handle.db.select().from(merchants).where(eq(merchants.id, grant.merchantId)).get();
      if (!merchant) continue;
      shops.push({
        merchant_id: merchant.id,
        shop_domain: merchant.shopDomain,
        name: merchant.name,
        grant_status: grant.status,
        oauth_bound: Boolean(merchant.accessTokenEnc),
        shopify_shop_id: merchant.shopifyShopId,
      });
    }
    return c.json({ shops });
  });

  app.get("/v1/seller/shops/:id/products", async (c) => {
    const seller = await auth.requireSeller(c);
    const merchant = findMerchant(handle, c.req.param("id"));
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Shop not found", 404);
    requireGrant(handle, seller.id, merchant.id);
    if (merchant.accessTokenEnc) {
      try {
        const token = decryptAccessToken(merchant.accessTokenEnc, handle.env.tokenSecret);
        const products = await fetchShopProducts({ shop: merchant.shopDomain, accessToken: token });
        if (products.length > 0) {
          return c.json({ oauth: true, products });
        }
      } catch {
        // fall through to cached catalog
      }
    }
    const cached = parseCatalogJson(merchant.catalogJson, merchant.shopDomain);
    const products =
      cached.length > 0
        ? cached
        : FIXTURE_CATALOG_PRODUCTS.map((p) => withCheckoutTemplate(merchant.shopDomain, p));
    return c.json({ oauth: Boolean(merchant.accessTokenEnc), products });
  });

  app.post("/v1/seller/shops/:id/webhooks", async (c) => {
    const seller = await auth.requireSeller(c);
    const merchant = findMerchant(handle, c.req.param("id"));
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Shop not found", 404);
    requireGrant(handle, seller.id, merchant.id);
    if (!merchant.accessTokenEnc) {
      throw jsonError("OAUTH_REQUIRED", "This shop has no Shopify token", 409);
    }
    const token = decryptAccessToken(merchant.accessTokenEnc, handle.env.tokenSecret);
    const origin = requestPublicOrigin(c.req, handle.env);
    const webhookUri = `${origin}/v1/webhooks/shopify`;
    const hooks = await registerWebhooks({
      shop: merchant.shopDomain,
      accessToken: token,
      webhookUri,
    });
    return c.json({ shop_domain: merchant.shopDomain, webhook_uri: webhookUri, webhooks: hooks });
  });

  app.post("/v1/simulate/connect_shop", async (c) => {
    const seller = await auth.requireDemoAndSeller(c);
    const body = simulateConnectShopSchema.parse(await c.req.json().catch(() => ({})));
    const shop = tryNormalizeShop(body.shop_domain) ?? body.shop_domain;
    const now = new Date();
    const id = newId("lnk_");
    const origin = requestPublicOrigin(c.req, handle.env);
    const urls = linkUrls(origin, id, shop);
    handle.db
      .insert(sellerLinks)
      .values({
        id,
        sellerAgentId: seller.id,
        shopDomain: shop,
        status: "pending",
        installUrl: urls.install_url,
        nonce: newNonce(),
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        merchantId: null,
        createdAt: now.toISOString(),
      })
      .run();
    return c.json(completeLink(handle, id, shop), 201);
  });

  app.post("/v1/simulate/shopify_oauth", async (c) => {
    const seller = await auth.requireDemoAndSeller(c);
    const body = simulateShopifyOauthSchema.parse(await c.req.json());
    const shop = normalizeShopDomain(body.shop_domain);
    const now = new Date();
    const catalog = (body.products ?? FIXTURE_CATALOG_PRODUCTS).map((p) => ({
      id: p.id,
      title: p.title,
      variant_id: p.variant_id,
      list_price: p.list_price ?? "0.00",
      currency: p.currency ?? "USD",
    }));
    const id = body.seller_link ?? newId("lnk_");
    const existing = handle.db.select().from(sellerLinks).where(eq(sellerLinks.id, id)).get();
    if (!existing) {
      const origin = requestPublicOrigin(c.req, handle.env);
      const urls = linkUrls(origin, id, shop);
      handle.db
        .insert(sellerLinks)
        .values({
          id,
          sellerAgentId: seller.id,
          shopDomain: shop,
          status: "pending",
          installUrl: urls.install_url,
          nonce: newNonce(),
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          merchantId: null,
          createdAt: now.toISOString(),
        })
        .run();
    }
    const connected = completeLink(handle, id, shop, {
      shopifyShopId: body.shopify_shop_id ?? "gid://shopify/Shop/sim",
      accessToken: `shpat_sim_${shop}`,
      name: body.shop_name ?? shop,
      catalog,
    });
    return c.json(
      {
        ...connected,
        oauth_bound: true,
        products: catalog.map((p) => withCheckoutTemplate(shop, p)),
      },
      201,
    );
  });

  app.post("/v1/seller/offers", async (c) => {
    const seller = await auth.requireSeller(c);
    const body = sellerCreateOfferSchema.parse(await c.req.json());
    const merchant = body.merchant_id
      ? findMerchant(handle, body.merchant_id)
      : findMerchant(handle, body.shop_domain ?? "");
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Shop not found or not granted", 404);
    requireGrant(handle, seller.id, merchant.id);
    const now = new Date().toISOString();
    const ids = body.selector.ids ?? [];
    const template = checkoutTemplateFor(merchant.shopDomain, ids, body.checkout?.tracked_url_template);
    const disclosure =
      body.disclosure ?? defaultDisclosure(merchant.name, body.reward, body.finder_fee ?? null);
    if (body.status === "live" && disclosure.length < 16) {
      throw jsonError("INVALID_BODY", "Live offers require a disclosure of at least 16 characters", 400);
    }
    let mandateId: string | null = null;
    if (body.status === "live") {
      const mandate = requireMandateForWrite(handle, {
        sellerAgentId: seller.id,
        merchant,
        write: writeFromCreate(body),
      });
      mandateId = mandate.id;
    }
    const id = body.id ?? newId("off_");
    handle.db
      .insert(offers)
      .values({
        id,
        merchantId: merchant.id,
        status: body.status,
        selectorType: body.selector.type,
        selectorIdsJson: JSON.stringify(ids),
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
        disclosure,
        checkoutUrlTemplate: template,
        ucp: merchant.accessTokenEnc ? 1 : 0,
        mandateId,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return c.json(toSellerOffer(handle, id), 201);
  });

  app.get("/v1/seller/offers", async (c) => {
    const seller = await auth.requireSeller(c);
    const shopFilter = c.req.query("shop_domain") ?? undefined;
    const statusFilter = c.req.query("status") ?? undefined;
    const grants = handle.db
      .select()
      .from(shopGrants)
      .where(and(eq(shopGrants.sellerAgentId, seller.id), eq(shopGrants.status, "active")))
      .all();
    const merchantIds = new Set(grants.map((g) => g.merchantId));
    const rows = handle.db.select().from(offers).all();
    const out = [];
    for (const row of rows) {
      if (!merchantIds.has(row.merchantId)) continue;
      if (statusFilter && row.status !== statusFilter) continue;
      const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
      if (!merchant) continue;
      if (shopFilter && merchant.shopDomain !== shopFilter) continue;
      out.push({ ...rowToOffer(row, merchant), mandate_id: row.mandateId });
    }
    return c.json({ offers: out });
  });

  app.patch("/v1/seller/offers/:id", async (c) => {
    const seller = await auth.requireSeller(c);
    const id = c.req.param("id");
    const body = sellerPatchOfferSchema.parse(await c.req.json());
    const row = handle.db.select().from(offers).where(eq(offers.id, id)).get();
    if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for offer", 500);
    requireGrant(handle, seller.id, merchant.id);
    const nextStatus = body.status ?? row.status;
    const ids = body.selector?.ids ?? (JSON.parse(row.selectorIdsJson) as string[]);
    const rewardType = body.reward?.type ?? row.rewardType;
    const rewardAmount = body.reward?.amount ?? row.rewardAmount;
    const finderType = body.finder_fee === null ? null : (body.finder_fee?.type ?? row.finderFeeType);
    const finderAmount = body.finder_fee === null ? null : (body.finder_fee?.amount ?? row.finderFeeAmount);
    const clawback = body.constraints?.clawback_days ?? row.clawbackDays;
    let mandateId = row.mandateId;
    if (nextStatus === "live") {
      const mandate = requireMandateForWrite(handle, {
        sellerAgentId: seller.id,
        merchant,
        write: {
          selectorType: body.selector?.type ?? row.selectorType,
          selectorIds: ids,
          rewardType,
          rewardAmount,
          finderFeeType: finderType,
          finderFeeAmount: finderAmount,
          clawbackDays: clawback,
          listPrice: body.selector?.list_price ?? row.listPrice,
          action: row.status === "live" ? "update" : "resume",
        },
      });
      mandateId = mandate.id;
    }
    const now = new Date().toISOString();
    handle.db
      .update(offers)
      .set({
        status: nextStatus,
        ...(body.selector?.type ? { selectorType: body.selector.type } : {}),
        ...(body.selector?.ids ? { selectorIdsJson: JSON.stringify(body.selector.ids) } : {}),
        ...(body.selector?.title !== undefined ? { selectorTitle: body.selector.title ?? null } : {}),
        ...(body.selector?.list_price !== undefined ? { listPrice: body.selector.list_price ?? null } : {}),
        ...(body.selector?.currency !== undefined ? { selectorCurrency: body.selector.currency ?? null } : {}),
        ...(body.reward?.type ? { rewardType: body.reward.type } : {}),
        ...(body.reward?.amount ? { rewardAmount: body.reward.amount } : {}),
        ...(body.reward?.currency ? { rewardCurrency: body.reward.currency } : {}),
        ...(body.finder_fee === null
          ? { finderFeeType: null, finderFeeAmount: null, finderFeeCurrency: null, finderFeeRecipient: null }
          : body.finder_fee
            ? {
                finderFeeType: body.finder_fee.type,
                finderFeeAmount: body.finder_fee.amount,
                finderFeeCurrency: body.finder_fee.currency,
                finderFeeRecipient: "agent",
              }
            : {}),
        ...(body.constraints?.clawback_days !== undefined ? { clawbackDays: body.constraints.clawback_days } : {}),
        ...(body.constraints?.ship_to ? { shipToJson: JSON.stringify(body.constraints.ship_to) } : {}),
        ...(body.constraints?.new_customer_only !== undefined
          ? { newCustomerOnly: body.constraints.new_customer_only ? 1 : 0 }
          : {}),
        ...(body.disclosure ? { disclosure: body.disclosure } : {}),
        ...(body.checkout?.tracked_url_template ? { checkoutUrlTemplate: body.checkout.tracked_url_template } : {}),
        ucp: merchant.accessTokenEnc ? 1 : row.ucp,
        mandateId,
        updatedAt: now,
      })
      .where(eq(offers.id, id))
      .run();
    return c.json(toSellerOffer(handle, id));
  });

  app.post("/v1/seller/offers/:id/pause", async (c) => {
    const seller = await auth.requireSeller(c);
    const id = c.req.param("id");
    const row = handle.db.select().from(offers).where(eq(offers.id, id)).get();
    if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
    requireGrant(handle, seller.id, row.merchantId);
    handle.db
      .update(offers)
      .set({ status: "paused", updatedAt: new Date().toISOString() })
      .where(eq(offers.id, id))
      .run();
    return c.json(toSellerOffer(handle, id));
  });

  app.post("/v1/seller/offers/:id/resume", async (c) => {
    const seller = await auth.requireSeller(c);
    const id = c.req.param("id");
    const row = handle.db.select().from(offers).where(eq(offers.id, id)).get();
    if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for offer", 500);
    requireGrant(handle, seller.id, merchant.id);
    const mandate = requireMandateForWrite(handle, {
      sellerAgentId: seller.id,
      merchant,
      write: {
        selectorType: row.selectorType,
        selectorIds: JSON.parse(row.selectorIdsJson) as string[],
        rewardType: row.rewardType,
        rewardAmount: row.rewardAmount,
        finderFeeType: row.finderFeeType,
        finderFeeAmount: row.finderFeeAmount,
        clawbackDays: row.clawbackDays,
        listPrice: row.listPrice,
        action: "resume",
      },
    });
    handle.db
      .update(offers)
      .set({ status: "live", mandateId: mandate.id, updatedAt: new Date().toISOString() })
      .where(eq(offers.id, id))
      .run();
    return c.json(toSellerOffer(handle, id));
  });

  app.get("/v1/seller/offers/:id/performance", async (c) => {
    const seller = await auth.requireSeller(c);
    const id = c.req.param("id");
    const row = handle.db.select().from(offers).where(eq(offers.id, id)).get();
    if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for offer", 500);
    requireGrant(handle, seller.id, merchant.id);
    const offer = rowToOffer(row, merchant);
    const tokenRows = handle.db.select().from(tokens).where(eq(tokens.offerId, id)).all();
    const tokenIds = tokenRows.map((t) => t.tokenId);
    const orderRows =
      tokenIds.length === 0
        ? []
        : handle.db.select().from(ordersExt).where(inArray(ordersExt.tokenId, tokenIds)).all();
    const pending = emptyBucket();
    const cleared = emptyBucket();
    const clawed = { count: 0, gmv: "0.00" };
    for (const order of orderRows) {
      const reward = computePayout({
        type: offer.reward.type,
        amount: offer.reward.amount,
        orderTotal: order.total,
      });
      const fee = offer.finder_fee
        ? computePayout({
            type: offer.finder_fee.type,
            amount: offer.finder_fee.amount,
            orderTotal: order.total,
          })
        : "0.00";
      if (order.status === "pending_hold") {
        pending.count += 1;
        pending.gmv = addMoney(pending.gmv, order.total);
        pending.reward = addMoney(pending.reward, reward);
        pending.finder_fee = addMoney(pending.finder_fee, fee);
      } else if (order.status === "cleared") {
        cleared.count += 1;
        cleared.gmv = addMoney(cleared.gmv, order.total);
        cleared.reward = addMoney(cleared.reward, reward);
        cleared.finder_fee = addMoney(cleared.finder_fee, fee);
      } else if (order.status === "clawed_back") {
        clawed.count += 1;
        clawed.gmv = addMoney(clawed.gmv, order.total);
      }
    }
    return c.json({
      offer_id: id,
      attributed_orders: pending.count + cleared.count + clawed.count,
      pending_hold: pending,
      cleared,
      clawed_back: clawed,
    });
  });

  app.post("/v1/seller/mandates", async (c) => {
    const seller = await auth.requireSeller(c);
    const body = proposeMandateSchema.parse(await c.req.json());
    const merchant = body.merchant_id
      ? findMerchant(handle, body.merchant_id)
      : findMerchant(handle, body.shop_domain ?? "");
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Shop not found or not granted", 404);
    requireGrant(handle, seller.id, merchant.id);
    return c.json(proposeMandate(handle, seller.id, merchant, body), 201);
  });

  app.get("/v1/seller/mandates", async (c) => {
    const seller = await auth.requireSeller(c);
    const shopFilter = c.req.query("shop_domain") ?? undefined;
    const rows = handle.db.select().from(mandates).where(eq(mandates.sellerAgentId, seller.id)).all();
    const out = [];
    for (const row of rows) {
      const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
      if (!merchant) continue;
      if (shopFilter && merchant.shopDomain !== shopFilter) continue;
      out.push(rowToMandate(row, merchant));
    }
    return c.json({ mandates: out });
  });

  app.get("/v1/seller/mandates/:id", async (c) => {
    const seller = await auth.requireSeller(c);
    const row = handle.db.select().from(mandates).where(eq(mandates.id, c.req.param("id"))).get();
    if (!row || row.sellerAgentId !== seller.id) {
      throw jsonError("MANDATE_NOT_FOUND", "Mandate not found", 404);
    }
    const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
    if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for mandate", 500);
    return c.json(rowToMandate(row, merchant));
  });

  app.post("/v1/seller/mandates/:id/activate", async (c) => {
    const seller = await auth.requireSeller(c);
    const body = (await c.req.json().catch(() => ({}))) as { human_confirmed?: boolean };
    return c.json(activateMandate(handle, seller.id, c.req.param("id"), body.human_confirmed === true));
  });

  app.post("/v1/seller/mandates/:id/revoke", async (c) => {
    const seller = await auth.requireSeller(c);
    const pauseOffers = c.req.query("pause_offers") === "true";
    return c.json(
      revokeMandate(handle, c.req.param("id"), {
        sellerAgentId: seller.id,
        pauseOffers,
      }),
    );
  });
}
