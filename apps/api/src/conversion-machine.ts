import {
  computePayout,
  fromCents,
  newId,
  normalizeMoney,
  toCents,
  type Conversion,
  type Offer,
} from "@offerlayer/schema";
import {
  agents,
  and,
  eq,
  gt,
  gte,
  hashApiKey,
  hashPrincipal,
  inArray,
  isNull,
  merchants,
  offers,
  orderRefunds,
  ordersExt,
  or,
  payouts,
  principals,
  rowToOffer,
  sql,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { issueToken, tokenExpiresAt, verifyToken, TokenError } from "@offerlayer/token";
import type { AttributedLine } from "./attribution.ts";
import { buildCheckoutHandoff } from "./checkout-attach.ts";
import { jsonError } from "./errors.ts";
import { logJson } from "./logger.ts";
import { requireCheckoutWithinLimits } from "./mandate.ts";
import { createCheckoutDiscount, decryptAccessToken, oneTimeDiscountCode } from "./shopify-admin.ts";

export function trackedUrl(template: string, token: string): string {
  if (template.includes("{token}")) return template.replaceAll("{token}", token);
  const join = template.includes("?") ? "&" : "?";
  return `${template}${join}agent_ref=${encodeURIComponent(token)}`;
}

function startOfUtcDay(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

export function loadOffer(
  handle: DbHandle,
  offerId: string,
): {
  offer: Offer;
  row: typeof offers.$inferSelect;
  merchant: typeof merchants.$inferSelect;
} {
  const row = handle.db.select().from(offers).where(eq(offers.id, offerId)).get();
  if (!row) throw jsonError("OFFER_NOT_FOUND", "Offer not found", 404);
  const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
  if (!merchant) throw jsonError("MERCHANT_NOT_FOUND", "Merchant missing for offer", 500);
  return { offer: rowToOffer(row, merchant), row, merchant };
}

/** Verify against the current signing secret, then the previous one during a rotation. */
function verifyWithRotation(token: string, handle: DbHandle, now: Date, opts: { ignoreExpiry?: boolean } = {}) {
  try {
    return verifyToken(token, handle.env.tokenSigningSecret, now, opts);
  } catch (err) {
    const previous = handle.env.tokenSigningSecretPrevious;
    if (!previous || !(err instanceof TokenError) || err.code !== "INVALID_TOKEN") throw err;
    return verifyToken(token, previous, now, opts);
  }
}

function countTokens(handle: DbHandle, where: ReturnType<typeof and>): number {
  const row = handle.db
    .select({ n: sql<number>`count(*)` })
    .from(tokens)
    .where(where)
    .get();
  return Number(row?.n ?? 0);
}

/**
 * Per-agent-key rate limits on minting checkouts. Counted from the tokens
 * table, so limits hold across processes that share the database. Throws 429
 * before anything is written or sent to Shopify.
 */
function enforceRateLimit(handle: DbHandle, issuedBy: string, now: Date): void {
  const agent = handle.db.select().from(agents).where(eq(agents.id, issuedBy)).get();
  const perMinute = agent?.ratePerMinute ?? handle.env.limits.checkoutsPerMinute;
  const perDay = agent?.ratePerDay ?? handle.env.limits.checkoutsPerDay;
  const windows: [number, number, string][] = [
    [60, perMinute, "minute"],
    [24 * 60 * 60, perDay, "day"],
  ];
  for (const [seconds, limit, label] of windows) {
    const since = new Date(now.getTime() - seconds * 1000).toISOString();
    const used = countTokens(handle, and(eq(tokens.issuedBy, issuedBy), gte(tokens.createdAt, since)));
    if (used >= limit) {
      throw jsonError("RATE_LIMITED", `Checkout limit for this key reached (${limit} per ${label})`, 429, {
        retry_after_seconds: label === "minute" ? 60 : 3600,
      });
    }
  }
}

export async function issueCheckout(
  handle: DbHandle,
  args: {
    offerId: string;
    agentId: string;
    /** The authenticated key making the request; rate limits count against it. */
    issuedBy?: string;
    principalRef?: string;
    referrerAgentId?: string | null;
    ttlSeconds?: number;
    now?: Date;
    exp?: number;
  },
) {
  const { offer, row, merchant } = loadOffer(handle, args.offerId);
  if (offer.status !== "live") {
    throw jsonError("OFFER_NOT_LIVE", "Offer is not live", 409);
  }
  const now = args.now ?? new Date();
  const limits = handle.env.limits;

  // Every check below runs before a token row or a Shopify discount exists.
  if (args.issuedBy) enforceRateLimit(handle, args.issuedBy, now);

  const principalHash = hashPrincipal(args.principalRef, handle.env.principalHashSecret);
  if (principalHash === "anon") {
    const today = countTokens(
      handle,
      and(eq(tokens.offerId, offer.id), eq(tokens.principalHash, "anon"), gte(tokens.createdAt, startOfUtcDay(now))),
    );
    if (today >= limits.anonCheckoutsPerOfferPerDay) {
      throw jsonError(
        "ANON_LIMIT",
        "Daily limit for checkouts without a principal_ref reached on this offer; pass principal_ref",
        429,
        { retry_after_seconds: 3600 },
      );
    }
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  const outstanding = countTokens(
    handle,
    and(eq(tokens.offerId, offer.id), isNull(tokens.consumedAt), gt(tokens.exp, nowSec)),
  );
  if (outstanding >= limits.maxOutstandingPerOffer) {
    throw jsonError("OUTSTANDING_LIMIT", "Too many unused checkouts are open on this offer; try again later", 429, {
      retry_after_seconds: 300,
    });
  }

  if (row.maxPerPrincipalPerDay && principalHash !== "anon") {
    const used = countPrincipalOrdersToday(handle, row.merchantId, principalHash, now);
    if (used >= row.maxPerPrincipalPerDay) {
      throw jsonError("CAP_EXCEEDED", "max_per_principal_per_day exceeded", 409);
    }
  }

  requireCheckoutWithinLimits(handle, row, now);

  const issued = issueToken(
    {
      offerId: offer.id,
      agentId: args.agentId,
      principalHash,
      referrerAgentId: args.referrerAgentId ?? null,
      ttlSeconds: args.ttlSeconds ?? limits.checkoutTtlSeconds,
      now,
      exp: args.exp,
    },
    handle.env.tokenSigningSecret,
  );
  const tokenId = newId("tok_");
  handle.db
    .insert(tokens)
    .values({
      tokenId,
      offerId: offer.id,
      agentId: args.agentId,
      principalHash,
      referrerAgentId: args.referrerAgentId ?? null,
      exp: issued.payload.exp,
      nonce: issued.payload.nce,
      rawJws: issued.token,
      consumedAt: null,
      issuedBy: args.issuedBy ?? null,
      createdAt: now.toISOString(),
    })
    .run();

  let discountCode: string | undefined;
  if (merchant.accessTokenEnc && offer.reward.type === "percent") {
    const code = oneTimeDiscountCode();
    const productGid = (offer.selector.ids ?? []).find((id) => /\/Product\//i.test(id)) ?? null;
    try {
      const accessToken = decryptAccessToken(merchant.accessTokenEnc, handle.env.accessTokenEncryptionKey, handle.env.accessTokenEncryptionKeyPrevious);
      const created = await createCheckoutDiscount({
        shop: merchant.shopDomain,
        accessToken,
        code,
        offerId: offer.id,
        percent: offer.reward.amount,
        productGid,
        endsAt: new Date(issued.payload.exp * 1000).toISOString(),
      });
      if (created.ok) {
        discountCode = code;
        handle.db
          .update(tokens)
          .set({ discountCode: code, discountNodeId: created.nodeId })
          .where(eq(tokens.tokenId, tokenId))
          .run();
      } else {
        logJson({ level: "warn", msg: "discount_create_failed", offer_id: offer.id, error: created.error });
      }
    } catch (err) {
      logJson({
        level: "warn",
        msg: "discount_create_failed",
        offer_id: offer.id,
        error: err instanceof Error ? err.message : "unknown",
      });
      discountCode = undefined;
    }
  }

  const handoff = buildCheckoutHandoff({ offer, token: issued.token, discountCode });
  return {
    token: issued.token,
    offer_id: offer.id,
    expires_at: tokenExpiresAt(issued.payload),
    checkout_url: handoff.permalink,
    disclosure: offer.disclosure,
    reward: offer.reward,
    finder_fee: offer.finder_fee,
    checkout: handoff,
  };
}

/**
 * Paid orders today for one shopper at one merchant. A shopper is matched
 * either by the email on the order or by the principal_ref the agent sent;
 * both are hashed the same way, so the two line up.
 */
function countPrincipalOrdersToday(
  handle: DbHandle,
  merchantId: string,
  principalHash: string,
  now: Date,
): number {
  const tokenIds = handle.db
    .select({ tokenId: tokens.tokenId })
    .from(tokens)
    .where(eq(tokens.principalHash, principalHash))
    .all()
    .map((t) => t.tokenId);
  const who =
    tokenIds.length > 0
      ? or(eq(ordersExt.emailHash, principalHash), inArray(ordersExt.tokenId, tokenIds))
      : eq(ordersExt.emailHash, principalHash);
  const row = handle.db
    .select({ n: sql<number>`count(*)` })
    .from(ordersExt)
    .where(
      and(
        eq(ordersExt.merchantId, merchantId),
        gte(ordersExt.paidAt, startOfUtcDay(now)),
        inArray(ordersExt.status, ["pending_hold", "cleared"]),
        who,
      ),
    )
    .get();
  return Number(row?.n ?? 0);
}

export function findTokenRow(handle: DbHandle, rawToken: string) {
  return handle.db.select().from(tokens).where(eq(tokens.rawJws, rawToken)).get();
}

export function conversionForToken(handle: DbHandle, rawToken: string, now = new Date()): Conversion {
  const row = findTokenRow(handle, rawToken);
  if (!row) {
    try {
      verifyWithRotation(rawToken, handle, now);
    } catch (err) {
      if (err instanceof TokenError && err.code === "EXPIRED_TOKEN") {
        return { token: rawToken, status: "expired" };
      }
    }
    throw jsonError("TOKEN_NOT_FOUND", "Unknown token", 404);
  }
  const order = handle.db.select().from(ordersExt).where(eq(ordersExt.tokenId, row.tokenId)).get();
  const { offer } = loadOffer(handle, row.offerId);
  if (!order) {
    const expired = row.exp <= Math.floor(now.getTime() / 1000);
    return {
      token: rawToken,
      status: expired ? "expired" : "issued",
    };
  }
  const pay = handle.db.select().from(payouts).where(eq(payouts.orderExtId, order.id)).all();
  const net = netTotal(order);
  const rewardAmount = computePayout({
    type: offer.reward.type,
    amount: offer.reward.amount,
    orderTotal: net,
  });
  const finderFeeAmount = offer.finder_fee
    ? computePayout({
        type: offer.finder_fee.type,
        amount: offer.finder_fee.amount,
        orderTotal: net,
      })
    : "0.00";
  return {
    token: rawToken,
    status: order.status as Conversion["status"],
    order_total: order.total,
    currency: order.currency,
    reward_amount: rewardAmount,
    finder_fee_amount: finderFeeAmount,
    hold_until: order.holdUntil,
    payouts: pay.map((p) => ({
      party: p.party as "buyer" | "agent",
      amount: p.amount,
      status: p.status,
    })),
  };
}

export function recordPaidOrder(
  handle: DbHandle,
  args: {
    token: string;
    /** Amount attributed to the offer. Defaults to orderTotal. */
    orderTotal: string;
    /** The whole order's total, when it differs from the attributed amount. */
    grossTotal?: string | null;
    attributedLines?: AttributedLine[] | null;
    currency: string;
    /** Raw order email. Hashed here; never stored. */
    email?: string | null;
    shopifyOrderId?: string | null;
    /** When set, the token's offer must belong to this shop. */
    expectedShop?: string | null;
    /** Verified webhooks accept tokens past expiry (see verifyToken). */
    ignoreExpiry?: boolean;
    now?: Date;
  },
): Conversion {
  const now = args.now ?? new Date();
  try {
    verifyWithRotation(args.token, handle, now, { ignoreExpiry: args.ignoreExpiry });
  } catch (err) {
    if (err instanceof TokenError && err.code === "EXPIRED_TOKEN") {
      throw jsonError("EXPIRED_TOKEN", "Token expired", 400);
    }
    throw jsonError("INVALID_TOKEN", err instanceof Error ? err.message : "Invalid token", 400);
  }

  const tokenRow = findTokenRow(handle, args.token);
  if (!tokenRow) throw jsonError("TOKEN_NOT_FOUND", "Unknown token", 404);

  const { offer, row, merchant } = loadOffer(handle, tokenRow.offerId);
  if (args.expectedShop && args.expectedShop.toLowerCase() !== merchant.shopDomain.toLowerCase()) {
    throw jsonError("SHOP_MISMATCH", "Token belongs to a different shop", 409);
  }
  if (tokenRow.consumedAt) {
    throw jsonError("TOKEN_CONSUMED", "Token already converted", 409);
  }
  if (offer.status !== "live") {
    throw jsonError("OFFER_NOT_LIVE", "Offer is not live", 409);
  }

  const orderEmailHash = args.email ? hashPrincipal(args.email, handle.env.principalHashSecret) : "anon";
  const emailHash =
    orderEmailHash !== "anon" ? orderEmailHash : tokenRow.principalHash !== "anon" ? tokenRow.principalHash : null;
  if (row.maxPerPrincipalPerDay && emailHash) {
    const used = countPrincipalOrdersToday(handle, merchant.id, emailHash, now);
    if (used >= row.maxPerPrincipalPerDay) {
      throw jsonError("CAP_EXCEEDED", "max_per_principal_per_day exceeded", 409);
    }
  }

  const holdUntil = new Date(now.getTime() + row.clawbackDays * 24 * 60 * 60 * 1000).toISOString();
  // Consume the token and record the order together. The conditional update
  // plus the unique index on orders_ext.token_id mean a duplicate delivery can
  // never count the same checkout twice.
  handle.sqlite.transaction(() => {
    const consumed = handle.db
      .update(tokens)
      .set({ consumedAt: now.toISOString() })
      .where(and(eq(tokens.tokenId, tokenRow.tokenId), isNull(tokens.consumedAt)))
      .run();
    if (consumed.changes !== 1) {
      throw jsonError("TOKEN_CONSUMED", "Token already converted", 409);
    }
    if (emailHash) {
      const existing = handle.db
        .select()
        .from(principals)
        .where(and(eq(principals.merchantId, merchant.id), eq(principals.emailHash, emailHash)))
        .get();
      if (!existing) {
        handle.db
          .insert(principals)
          .values({
            id: newId("prn_"),
            merchantId: merchant.id,
            emailHash,
            shopifyCustomerId: null,
            firstSeenAt: now.toISOString(),
          })
          .run();
      }
    }
    handle.db
      .insert(ordersExt)
      .values({
        id: newId("ord_"),
        merchantId: merchant.id,
        shopifyOrderId: args.shopifyOrderId ?? null,
        tokenId: tokenRow.tokenId,
        total: normalizeMoney(args.orderTotal),
        orderTotal: args.grossTotal ? normalizeMoney(args.grossTotal) : null,
        attributedLinesJson: args.attributedLines ? JSON.stringify(args.attributedLines) : null,
        refundedTotal: "0.00",
        currency: args.currency,
        emailHash,
        status: "pending_hold",
        paidAt: now.toISOString(),
        holdUntil,
        clawedAt: null,
      })
      .run();
  })();

  return conversionForToken(handle, args.token, now);
}

function netTotal(order: typeof ordersExt.$inferSelect): string {
  const net = toCents(order.total) - toCents(order.refundedTotal ?? "0.00");
  return fromCents(net > 0n ? net : 0n);
}

export function clearHold(handle: DbHandle, rawToken: string, now = new Date()): Conversion {
  const tokenRow = findTokenRow(handle, rawToken);
  if (!tokenRow) throw jsonError("TOKEN_NOT_FOUND", "Unknown token", 404);
  const order = handle.db.select().from(ordersExt).where(eq(ordersExt.tokenId, tokenRow.tokenId)).get();
  if (!order) throw jsonError("ORDER_NOT_FOUND", "No paid order for token", 404);
  if (order.status === "cleared") return conversionForToken(handle, rawToken, now);
  if (order.status !== "pending_hold") {
    throw jsonError("INVALID_STATE", `Cannot clear order in status ${order.status}`, 409);
  }
  const { offer } = loadOffer(handle, tokenRow.offerId);
  const net = netTotal(order);
  const rewardAmount = computePayout({
    type: offer.reward.type,
    amount: offer.reward.amount,
    orderTotal: net,
  });
  const finderFeeAmount = offer.finder_fee
    ? computePayout({
        type: offer.finder_fee.type,
        amount: offer.finder_fee.amount,
        orderTotal: net,
      })
    : "0.00";
  handle.db.update(ordersExt).set({ status: "cleared" }).where(eq(ordersExt.id, order.id)).run();
  handle.db
    .insert(payouts)
    .values({
      id: newId("pay_"),
      orderExtId: order.id,
      party: "buyer",
      agentId: null,
      amount: rewardAmount,
      currency: order.currency,
      status: "stubbed",
    })
    .run();
  handle.db
    .insert(payouts)
    .values({
      id: newId("pay_"),
      orderExtId: order.id,
      party: "agent",
      agentId: tokenRow.agentId,
      amount: finderFeeAmount,
      currency: order.currency,
      status: "stubbed",
    })
    .run();
  return conversionForToken(handle, rawToken, now);
}

export function findOrder(
  handle: DbHandle,
  args: { token?: string; shopifyOrderId?: string },
): typeof ordersExt.$inferSelect | undefined {
  let order: typeof ordersExt.$inferSelect | undefined;
  if (args.shopifyOrderId) {
    order = handle.db.select().from(ordersExt).where(eq(ordersExt.shopifyOrderId, args.shopifyOrderId)).get();
  }
  if (!order && args.token) {
    const tokenRow = findTokenRow(handle, args.token);
    if (tokenRow) {
      order = handle.db.select().from(ordersExt).where(eq(ordersExt.tokenId, tokenRow.tokenId)).get();
    }
  }
  return order;
}

/**
 * Record a refund (or a cancellation, with `full`) against an attributed
 * order. Partial refunds reduce the attributed amount proportionally; only a
 * full refund during the hold claws the conversion back. Each Shopify refund
 * id is applied at most once.
 */
export function applyRefund(
  handle: DbHandle,
  args: {
    order: typeof ordersExt.$inferSelect;
    /** Cents of attributed value refunded; ignored when `full`. */
    amountCents?: bigint;
    full?: boolean;
    refundId?: string | null;
    now?: Date;
  },
): Conversion | { ignored: true } {
  const now = args.now ?? new Date();
  const order = args.order;
  const total = toCents(order.total);
  const already = toCents(order.refundedTotal ?? "0.00");
  const want = args.full ? total - already : (args.amountCents ?? 0n);
  const delta = want < 0n ? 0n : want > total - already ? total - already : want;
  const refundedTotal = fromCents(already + delta);
  const fullyRefunded = already + delta >= total;

  handle.sqlite.transaction(() => {
    if (args.refundId) {
      const dup = handle.db
        .select()
        .from(orderRefunds)
        .where(and(eq(orderRefunds.orderExtId, order.id), eq(orderRefunds.shopifyRefundId, args.refundId)))
        .get();
      if (dup) return;
      handle.db
        .insert(orderRefunds)
        .values({
          id: newId("rfd_"),
          orderExtId: order.id,
          shopifyRefundId: args.refundId,
          amount: fromCents(delta),
          createdAt: now.toISOString(),
        })
        .run();
    }
    const clawback = fullyRefunded && order.status === "pending_hold";
    handle.db
      .update(ordersExt)
      .set({
        refundedTotal,
        ...(clawback ? { status: "clawed_back", clawedAt: now.toISOString() } : {}),
      })
      .where(eq(ordersExt.id, order.id))
      .run();
    if (clawback) {
      handle.db
        .update(payouts)
        .set({ status: "failed" })
        .where(and(eq(payouts.orderExtId, order.id), inArray(payouts.status, ["pending", "ready"])))
        .run();
    }
  })();

  const tokenRow = handle.db.select().from(tokens).where(eq(tokens.tokenId, order.tokenId)).get();
  if (!tokenRow) return { ignored: true };
  return conversionForToken(handle, tokenRow.rawJws, now);
}

export function lookupAgentByKey(handle: DbHandle, apiKey: string) {
  const digest = hashApiKey(apiKey);
  return handle.db
    .select()
    .from(agents)
    .where(and(eq(agents.apiKeyHash, digest), eq(agents.status, "active")))
    .get();
}
