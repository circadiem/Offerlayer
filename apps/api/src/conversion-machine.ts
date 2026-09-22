import { computePayout, newId, normalizeMoney, type Conversion, type Offer } from "@offerlayer/schema";
import {
  agents,
  and,
  eq,
  gte,
  hashApiKey,
  hashPrincipal,
  inArray,
  merchants,
  offers,
  ordersExt,
  payouts,
  principals,
  rowToOffer,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { issueToken, tokenExpiresAt, verifyToken, TokenError } from "@offerlayer/token";
import { buildCheckoutHandoff } from "./checkout-attach.ts";
import { jsonError } from "./errors.ts";

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

export function issueCheckout(
  handle: DbHandle,
  args: {
    offerId: string;
    agentId: string;
    principalRef?: string;
    referrerAgentId?: string | null;
    ttlSeconds?: number;
    now?: Date;
    exp?: number;
  },
) {
  const { offer, row } = loadOffer(handle, args.offerId);
  if (offer.status !== "live") {
    throw jsonError("OFFER_NOT_LIVE", "Offer is not live", 409);
  }
  const now = args.now ?? new Date();
  const principalHash = hashPrincipal(args.principalRef);
  if (row.maxPerPrincipalPerDay && principalHash !== "anon") {
    const used = countPrincipalOrdersToday(handle, row.merchantId, principalHash, now);
    if (used >= row.maxPerPrincipalPerDay) {
      throw jsonError("CAP_EXCEEDED", "max_per_principal_per_day exceeded", 409);
    }
  }
  const issued = issueToken(
    {
      offerId: offer.id,
      agentId: args.agentId,
      principalHash,
      referrerAgentId: args.referrerAgentId ?? null,
      ttlSeconds: args.ttlSeconds,
      now,
      exp: args.exp,
    },
    handle.env.tokenSecret,
  );
  handle.db
    .insert(tokens)
    .values({
      tokenId: newId("tok_"),
      offerId: offer.id,
      agentId: args.agentId,
      principalHash,
      referrerAgentId: args.referrerAgentId ?? null,
      exp: issued.payload.exp,
      nonce: issued.payload.nce,
      rawJws: issued.token,
      consumedAt: null,
      createdAt: now.toISOString(),
    })
    .run();

  const handoff = buildCheckoutHandoff({ offer, token: issued.token });
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

function countPrincipalOrdersToday(
  handle: DbHandle,
  merchantId: string,
  principalHash: string,
  now: Date,
): number {
  const from = startOfUtcDay(now);
  const tokenRows = handle.db
    .select({ tokenId: tokens.tokenId })
    .from(tokens)
    .where(eq(tokens.principalHash, principalHash))
    .all();
  if (tokenRows.length === 0) return 0;
  const ids = tokenRows.map((t) => t.tokenId);
  return handle.db
    .select()
    .from(ordersExt)
    .where(
      and(
        eq(ordersExt.merchantId, merchantId),
        gte(ordersExt.paidAt, from),
        inArray(ordersExt.tokenId, ids),
        inArray(ordersExt.status, ["pending_hold", "cleared"]),
      ),
    )
    .all().length;
}

export function findTokenRow(handle: DbHandle, rawToken: string) {
  return handle.db.select().from(tokens).where(eq(tokens.rawJws, rawToken)).get();
}

export function conversionForToken(handle: DbHandle, rawToken: string, now = new Date()): Conversion {
  const row = findTokenRow(handle, rawToken);
  if (!row) {
    try {
      verifyToken(rawToken, handle.env.tokenSecret, now);
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
  const rewardAmount = computePayout({
    type: offer.reward.type,
    amount: offer.reward.amount,
    orderTotal: order.total,
  });
  const finderFeeAmount = offer.finder_fee
    ? computePayout({
        type: offer.finder_fee.type,
        amount: offer.finder_fee.amount,
        orderTotal: order.total,
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
    orderTotal: string;
    currency: string;
    emailHash?: string | null;
    shopifyOrderId?: string | null;
    now?: Date;
  },
): Conversion {
  const now = args.now ?? new Date();
  try {
    verifyToken(args.token, handle.env.tokenSecret, now);
  } catch (err) {
    if (err instanceof TokenError && err.code === "EXPIRED_TOKEN") {
      throw jsonError("EXPIRED_TOKEN", "Token expired", 400);
    }
    throw jsonError("INVALID_TOKEN", err instanceof Error ? err.message : "Invalid token", 400);
  }

  const tokenRow = findTokenRow(handle, args.token);
  if (!tokenRow) throw jsonError("TOKEN_NOT_FOUND", "Unknown token", 404);
  if (tokenRow.consumedAt) {
    throw jsonError("TOKEN_CONSUMED", "Token already converted", 409);
  }

  const { offer, row, merchant } = loadOffer(handle, tokenRow.offerId);
  if (offer.status !== "live") {
    throw jsonError("OFFER_NOT_LIVE", "Offer is not live", 409);
  }

  const emailHash = args.emailHash ?? (tokenRow.principalHash !== "anon" ? tokenRow.principalHash : null);
  if (row.maxPerPrincipalPerDay) {
    const capKey = emailHash ?? tokenRow.principalHash;
    if (capKey && capKey !== "anon") {
      const used = countOrdersByEmailToday(handle, merchant.id, capKey, now);
      if (used >= row.maxPerPrincipalPerDay) {
        throw jsonError("CAP_EXCEEDED", "max_per_principal_per_day exceeded", 409);
      }
    }
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

  const holdUntil = new Date(now.getTime() + row.clawbackDays * 24 * 60 * 60 * 1000).toISOString();
  handle.db
    .insert(ordersExt)
    .values({
      id: newId("ord_"),
      merchantId: merchant.id,
      shopifyOrderId: args.shopifyOrderId ?? null,
      tokenId: tokenRow.tokenId,
      total: normalizeMoney(args.orderTotal),
      currency: args.currency,
      emailHash: emailHash ?? null,
      status: "pending_hold",
      paidAt: now.toISOString(),
      holdUntil,
      clawedAt: null,
    })
    .run();

  handle.db
    .update(tokens)
    .set({ consumedAt: now.toISOString() })
    .where(eq(tokens.tokenId, tokenRow.tokenId))
    .run();

  return conversionForToken(handle, args.token, now);
}

function countOrdersByEmailToday(
  handle: DbHandle,
  merchantId: string,
  emailHash: string,
  now: Date,
): number {
  const from = startOfUtcDay(now);
  return handle.db
    .select()
    .from(ordersExt)
    .where(
      and(
        eq(ordersExt.merchantId, merchantId),
        eq(ordersExt.emailHash, emailHash),
        gte(ordersExt.paidAt, from),
        inArray(ordersExt.status, ["pending_hold", "cleared"]),
      ),
    )
    .all().length;
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
  const rewardAmount = computePayout({
    type: offer.reward.type,
    amount: offer.reward.amount,
    orderTotal: order.total,
  });
  const finderFeeAmount = offer.finder_fee
    ? computePayout({
        type: offer.finder_fee.type,
        amount: offer.finder_fee.amount,
        orderTotal: order.total,
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

export function clawbackOrder(
  handle: DbHandle,
  args: { token?: string; shopifyOrderId?: string; now?: Date },
): Conversion | { ignored: true } {
  const now = args.now ?? new Date();
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
  if (!order) return { ignored: true };
  if (order.status === "clawed_back") {
    const tokenRow = handle.db.select().from(tokens).where(eq(tokens.tokenId, order.tokenId)).get();
    return tokenRow ? conversionForToken(handle, tokenRow.rawJws, now) : { ignored: true };
  }
  if (order.status !== "pending_hold") {
    throw jsonError("INVALID_STATE", `Cannot claw back order in status ${order.status}`, 409);
  }
  handle.db
    .update(ordersExt)
    .set({ status: "clawed_back", clawedAt: now.toISOString() })
    .where(eq(ordersExt.id, order.id))
    .run();
  handle.db
    .update(payouts)
    .set({ status: "failed" })
    .where(and(eq(payouts.orderExtId, order.id), inArray(payouts.status, ["pending", "ready"])))
    .run();
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
