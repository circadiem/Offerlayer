import { newId } from "@offerlayer/schema";
import {
  and,
  complianceRequests,
  eq,
  hashPrincipal,
  inArray,
  isNull,
  mandates,
  merchants,
  offers,
  orderRefunds,
  ordersExt,
  or,
  payouts,
  principals,
  sellerLinks,
  shopGrants,
  tokens,
  webhookEvents,
  type DbHandle,
  type Queryable,
} from "@offerlayer/db";
import { jsonError } from "./errors.ts";
import { logJson } from "./logger.ts";

/*
 * Shop lifecycle webhooks: app/uninstalled, and Shopify's mandatory privacy
 * topics (customers/data_request, customers/redact, shop/redact).
 *
 * These change or delete data, so the shop always comes from the HMAC-signed
 * payload, never from the unsigned X-Shopify-Shop-Domain header. Each must be
 * answered 2xx; Shopify gives 30 days to complete the action, and these
 * complete inline.
 */

export const LIFECYCLE_TOPICS = new Set([
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === "number" || typeof x === "string").map(String) : [];
}

/** The shop named in the signed payload. */
function payloadShop(topic: string, payload: Record<string, unknown>): string {
  const raw =
    topic === "app/uninstalled"
      ? (payload.myshopify_domain ?? payload.domain)
      : payload.shop_domain;
  if (typeof raw !== "string" || !raw.trim()) {
    throw jsonError("SHOP_DOMAIN_MISSING", `${topic} payload has no shop domain`, 400);
  }
  return raw.trim().toLowerCase();
}

async function record(
  db: Queryable,
  topic: string,
  shopDomain: string,
  summary: Record<string, unknown>,
  now: Date,
): Promise<string> {
  const id = newId("cmp_");
  await db.insert(complianceRequests).values({
    id,
    topic,
    shopDomain,
    summaryJson: JSON.stringify(summary),
    receivedAt: now.toISOString(),
    completedAt: topic === "customers/data_request" ? null : now.toISOString(),
  });
  return id;
}

export async function handleLifecycleWebhook(
  handle: DbHandle,
  topic: string,
  payloadRaw: unknown,
  now = new Date(),
): Promise<{ ok: true; ignored?: boolean; [k: string]: unknown }> {
  const payload = rec(payloadRaw);
  const shop = payloadShop(topic, payload);
  const [merchant] = await handle.db.select().from(merchants).where(eq(merchants.shopDomain, shop)).limit(1);

  if (topic === "app/uninstalled") {
    if (!merchant) return { ok: true, ignored: true };
    return { ok: true, ...(await uninstall(handle, merchant.id, now)) };
  }

  if (topic === "shop/redact") {
    const counts = merchant ? await redactShop(handle, merchant.id, shop) : { merchants: 0 };
    await record(handle.db, topic, shop, { shop_id: payload.shop_id ?? null, deleted: counts }, now);
    logJson({ level: "info", msg: "COMPLIANCE_SHOP_REDACT", shop, deleted: counts });
    return { ok: true, deleted: counts };
  }

  const customer = rec(payload.customer);
  const email = typeof customer.email === "string" ? customer.email : null;
  const emailHash = email ? hashPrincipal(email, handle.env.principalHashSecret) : null;

  if (topic === "customers/data_request") {
    const orderIds = idList(payload.orders_requested);
    const rows = merchant ? await customerOrders(handle.db, merchant.id, orderIds, emailHash) : [];
    // What we hold for a customer: attributed order ids and amounts, and a
    // keyed hash of their email. No name, address, phone, or raw email.
    const summary = {
      shopify_request_id: rec(payload.data_request).id ?? null,
      customer_id: customer.id ?? null,
      data_held: rows.map((o) => ({
        shopify_order_id: o.shopifyOrderId,
        attributed_total: o.total,
        currency: o.currency,
        status: o.status,
        paid_at: o.paidAt,
      })),
      email_hash_stored: rows.some((o) => o.emailHash !== null),
    };
    const id = await record(handle.db, topic, shop, summary, now);
    logJson({ level: "info", msg: "COMPLIANCE_DATA_REQUEST", shop, request: id, orders: rows.length });
    return { ok: true, request_id: id, orders: rows.length };
  }

  if (topic === "customers/redact") {
    const orderIds = idList(payload.orders_to_redact);
    const counts = merchant ? await redactCustomer(handle, merchant.id, orderIds, emailHash) : { orders: 0 };
    await record(handle.db, topic, shop, { customer_id: customer.id ?? null, redacted: counts }, now);
    logJson({ level: "info", msg: "COMPLIANCE_CUSTOMER_REDACT", shop, redacted: counts });
    return { ok: true, redacted: counts };
  }

  return { ok: true, ignored: true };
}

async function customerOrders(
  db: Queryable,
  merchantId: string,
  orderIds: string[],
  emailHash: string | null,
) {
  const who = [
    ...(orderIds.length > 0 ? [inArray(ordersExt.shopifyOrderId, orderIds)] : []),
    ...(emailHash ? [eq(ordersExt.emailHash, emailHash)] : []),
  ];
  if (who.length === 0) return [];
  return db
    .select()
    .from(ordersExt)
    .where(and(eq(ordersExt.merchantId, merchantId), or(...who)));
}

/**
 * The merchant removed the app: stop offering, forget the access token.
 * Codes already issued cannot be deleted (Shopify revokes our token on
 * uninstall); they expire within the checkout TTL. Mark them so the cleanup
 * job does not keep retrying.
 */
async function uninstall(handle: DbHandle, merchantId: string, now: Date) {
  return handle.db.transaction(async (tx) => {
    const paused = await tx
      .update(offers)
      .set({ status: "paused", updatedAt: now.toISOString() })
      .where(and(eq(offers.merchantId, merchantId), eq(offers.status, "live")))
      .returning({ id: offers.id });
    await tx.update(merchants).set({ accessTokenEnc: null }).where(eq(merchants.id, merchantId));
    const offerIds = (await tx.select({ id: offers.id }).from(offers).where(eq(offers.merchantId, merchantId))).map(
      (o) => o.id,
    );
    let abandoned = 0;
    if (offerIds.length > 0) {
      const rows = await tx
        .update(tokens)
        .set({ discountCleanupError: "app uninstalled; the code expires at its end time" })
        .where(
          and(
            inArray(tokens.offerId, offerIds),
            isNull(tokens.consumedAt),
            isNull(tokens.discountDeletedAt),
          ),
        )
        .returning({ id: tokens.tokenId });
      abandoned = rows.length;
    }
    logJson({ level: "info", msg: "APP_UNINSTALLED", merchant_id: merchantId, paused: paused.length });
    return { paused_offers: paused.length, open_codes: abandoned };
  });
}

async function redactCustomer(
  handle: DbHandle,
  merchantId: string,
  orderIds: string[],
  emailHash: string | null,
) {
  return handle.db.transaction(async (tx) => {
    const rows = await customerOrders(tx, merchantId, orderIds, emailHash);
    if (rows.length > 0) {
      await tx
        .update(ordersExt)
        .set({ emailHash: null })
        .where(inArray(ordersExt.id, rows.map((r) => r.id)));
    }
    let principalRows = 0;
    let tokenRows = 0;
    if (emailHash) {
      principalRows = (
        await tx
          .delete(principals)
          .where(and(eq(principals.merchantId, merchantId), eq(principals.emailHash, emailHash)))
          .returning({ id: principals.id })
      ).length;
      const offerIds = (
        await tx.select({ id: offers.id }).from(offers).where(eq(offers.merchantId, merchantId))
      ).map((o) => o.id);
      if (offerIds.length > 0) {
        tokenRows = (
          await tx
            .update(tokens)
            .set({ principalHash: "redacted" })
            .where(and(inArray(tokens.offerId, offerIds), eq(tokens.principalHash, emailHash)))
            .returning({ id: tokens.tokenId })
        ).length;
      }
    }
    return { orders: rows.length, principals: principalRows, tokens: tokenRows };
  });
}

/** Shopify asks for this 48 hours after uninstall: delete everything for the shop. */
async function redactShop(handle: DbHandle, merchantId: string, shopDomain: string) {
  return handle.db.transaction(async (tx) => {
    const offerIds = (await tx.select({ id: offers.id }).from(offers).where(eq(offers.merchantId, merchantId))).map(
      (o) => o.id,
    );
    const orderIds = (
      await tx.select({ id: ordersExt.id }).from(ordersExt).where(eq(ordersExt.merchantId, merchantId))
    ).map((o) => o.id);
    const n = async (p: Promise<unknown[]>) => (await p).length;
    const counts = {
      payouts: orderIds.length
        ? await n(tx.delete(payouts).where(inArray(payouts.orderExtId, orderIds)).returning({ id: payouts.id }))
        : 0,
      refunds: orderIds.length
        ? await n(
            tx.delete(orderRefunds).where(inArray(orderRefunds.orderExtId, orderIds)).returning({ id: orderRefunds.id }),
          )
        : 0,
      orders: await n(tx.delete(ordersExt).where(eq(ordersExt.merchantId, merchantId)).returning({ id: ordersExt.id })),
      tokens: offerIds.length
        ? await n(tx.delete(tokens).where(inArray(tokens.offerId, offerIds)).returning({ id: tokens.tokenId }))
        : 0,
      offers: await n(tx.delete(offers).where(eq(offers.merchantId, merchantId)).returning({ id: offers.id })),
      mandates: await n(tx.delete(mandates).where(eq(mandates.merchantId, merchantId)).returning({ id: mandates.id })),
      grants: await n(
        tx.delete(shopGrants).where(eq(shopGrants.merchantId, merchantId)).returning({ id: shopGrants.id }),
      ),
      links: await n(
        tx
          .delete(sellerLinks)
          .where(or(eq(sellerLinks.merchantId, merchantId), eq(sellerLinks.shopDomain, shopDomain)))
          .returning({ id: sellerLinks.id }),
      ),
      principals: await n(
        tx.delete(principals).where(eq(principals.merchantId, merchantId)).returning({ id: principals.id }),
      ),
      webhook_events: await n(
        tx
          .delete(webhookEvents)
          .where(eq(webhookEvents.shopDomain, shopDomain))
          .returning({ id: webhookEvents.webhookId }),
      ),
      merchants: await n(tx.delete(merchants).where(eq(merchants.id, merchantId)).returning({ id: merchants.id })),
    };
    return counts;
  });
}
