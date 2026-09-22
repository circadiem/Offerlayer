import {
  addMoney,
  compareMoney,
  computePayout,
  newId,
  proposeMandateSchema,
  type MandateAllow,
  type MandateCaps,
  type MandateSelector,
} from "@offerlayer/schema";
import {
  and,
  eq,
  mandates,
  merchants,
  offers,
  ordersExt,
  payouts,
  tokens,
  type DbHandle,
} from "@offerlayer/db";
import { jsonError } from "./errors.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 90;
const MAX_TTL_DAYS = 365;

export type MandateRow = typeof mandates.$inferSelect;

export type MandateWrite = {
  selectorType: string;
  selectorIds: string[];
  rewardType: string;
  rewardAmount: string;
  finderFeeType?: string | null;
  finderFeeAmount?: string | null;
  clawbackDays: number;
  listPrice?: string | null;
  action: "publish" | "resume" | "update";
};

export function generateMandateCardText(args: {
  shopName: string;
  shopDomain: string;
  caps: MandateCaps;
  selector: MandateSelector;
  expiresAt: string;
}): string {
  const until = args.expiresAt.slice(0, 10);
  const ids = (args.selector.ids ?? []).join(", ");
  const scope =
    args.selector.type === "shop"
      ? "the whole shop"
      : args.selector.type === "collection"
        ? `collection ${ids || "(unspecified)"}`
        : `product ${ids || "(unspecified)"}`;
  return `Allow Offerlayer to publish, pause, resume, and update funded offers on ${args.shopName} (${args.shopDomain}, ${scope}) through ${until}. Buyer reward cap: $${args.caps.max_reward_flat} or ${args.caps.max_reward_percent}%. Finder fee cap: $${args.caps.max_finder_fee_flat} or ${args.caps.max_finder_fee_percent}%. Daily liability cap: $${args.caps.max_daily_liability}. Max clawback ${args.caps.max_clawback_days} days. This is a standing mandate. It does not skip Shopify install, and it does not skip buyer checkout approval. Caps still apply even if a connector is set to Always allow.`;
}

export function rowToMandate(row: MandateRow, merchant: { shopDomain: string }) {
  return {
    id: row.id,
    seller_agent_id: row.sellerAgentId,
    merchant_id: row.merchantId,
    shop_domain: merchant.shopDomain,
    status: row.status,
    expires_at: row.expiresAt,
    allow: JSON.parse(row.allowJson) as MandateAllow,
    caps: JSON.parse(row.capsJson) as MandateCaps,
    selector: JSON.parse(row.selectorJson) as MandateSelector,
    card_text: row.cardText,
    human_confirmed_at: row.humanConfirmedAt,
    revoked_at: row.revokedAt,
    superseded_by: row.supersededBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function resolveExpiresAt(raw: string | undefined, now: Date): string {
  if (!raw) return new Date(now.getTime() + DEFAULT_TTL_DAYS * DAY_MS).toISOString();
  const exp = new Date(raw);
  if (Number.isNaN(exp.getTime())) throw jsonError("INVALID_BODY", "expires_at must be an ISO timestamp", 400);
  if (exp.getTime() <= now.getTime()) throw jsonError("INVALID_BODY", "expires_at must be in the future", 400);
  const max = now.getTime() + MAX_TTL_DAYS * DAY_MS;
  if (exp.getTime() > max) throw jsonError("INVALID_BODY", "expires_at cannot be more than 365 days out", 400);
  return exp.toISOString();
}

function requiredCard(shopDomain: string): string {
  return `Allow Offerlayer to publish funded offers on ${shopDomain} under a standing mandate? Confirm the exact card_text from propose_mandate before any live write.`;
}

function exceededCard(shopDomain: string, detail: string, until?: string): string {
  const through = until ? ` through ${until.slice(0, 10)}` : "";
  return `Allow Offerlayer to ${detail} on ${shopDomain}${through}? Confirm a new or amended mandate. Do not retry the write until it is active.`;
}

export function loadActiveMandate(
  handle: DbHandle,
  sellerAgentId: string,
  merchantId: string,
  now = new Date(),
): MandateRow | null {
  const rows = handle.db
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.sellerAgentId, sellerAgentId),
        eq(mandates.merchantId, merchantId),
        eq(mandates.status, "active"),
      ),
    )
    .all();
  const row = rows[0] ?? null;
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() <= now.getTime()) {
    handle.db
      .update(mandates)
      .set({ status: "expired", updatedAt: now.toISOString() })
      .where(eq(mandates.id, row.id))
      .run();
    return null;
  }
  return row;
}

function idsSubset(offerIds: string[], mandateIds: string[]): boolean {
  if (mandateIds.length === 0) return true;
  if (offerIds.length === 0) return false;
  const allowed = new Set(mandateIds);
  return offerIds.every((id) => allowed.has(id));
}

function selectorAllowed(mandateSel: MandateSelector, write: MandateWrite): boolean {
  if (mandateSel.type === "shop") return true;
  if (write.selectorType === "shop") return false;
  if (mandateSel.type === "collection") {
    if (write.selectorType === "collection") return idsSubset(write.selectorIds, mandateSel.ids ?? []);
    return idsSubset(write.selectorIds, mandateSel.ids ?? []);
  }
  if (write.selectorType !== "product") return false;
  return idsSubset(write.selectorIds, mandateSel.ids ?? []);
}

function capExceeded(
  type: string,
  amount: string,
  maxFlat: string,
  maxPercent: string,
): string | null {
  if (type === "percent") {
    if (compareMoney(amount, maxPercent) > 0) return `percent ${amount}% exceeds cap ${maxPercent}%`;
    return null;
  }
  if (compareMoney(amount, maxFlat) > 0) return `$${amount} exceeds cap $${maxFlat}`;
  return null;
}

function worstCaseReward(write: MandateWrite): string {
  if (write.rewardType === "flat") return write.rewardAmount.includes(".") ? write.rewardAmount : `${write.rewardAmount}.00`;
  const base = write.listPrice && write.listPrice.length > 0 ? write.listPrice : "100.00";
  return computePayout({ type: "percent", amount: write.rewardAmount, orderTotal: base });
}

function dailyRewardUsed(
  handle: DbHandle,
  sellerAgentId: string,
  merchantId: string,
  now: Date,
): string {
  const sellerMandates = handle.db
    .select()
    .from(mandates)
    .where(and(eq(mandates.sellerAgentId, sellerAgentId), eq(mandates.merchantId, merchantId)))
    .all();
  const manIds = new Set(sellerMandates.map((m) => m.id));
  const offerRows = handle.db.select().from(offers).where(eq(offers.merchantId, merchantId)).all();
  const scoped = offerRows.filter((o) => o.mandateId && manIds.has(o.mandateId));
  const offerIds = new Set(scoped.map((o) => o.id));
  if (offerIds.size === 0) return "0.00";
  const day = now.toISOString().slice(0, 10);
  let sum = "0.00";
  const tokenRows = handle.db.select().from(tokens).all().filter((t) => offerIds.has(t.offerId));
  const tokenIds = new Set(tokenRows.map((t) => t.tokenId));
  const orders = handle.db
    .select()
    .from(ordersExt)
    .all()
    .filter(
      (o) =>
        tokenIds.has(o.tokenId) &&
        (o.status === "pending_hold" || o.status === "cleared") &&
        o.paidAt.startsWith(day),
    );
  for (const order of orders) {
    const pays = handle.db.select().from(payouts).where(eq(payouts.orderExtId, order.id)).all();
    const buyer = pays.find((p) => p.party === "buyer");
    if (buyer) sum = addMoney(sum, buyer.amount);
  }
  return sum;
}

export function requireMandateForWrite(
  handle: DbHandle,
  args: {
    sellerAgentId: string;
    merchant: { id: string; shopDomain: string; name: string };
    write: MandateWrite;
    now?: Date;
  },
): MandateRow {
  const now = args.now ?? new Date();
  const merchant = args.merchant;
  const row = loadActiveMandate(handle, args.sellerAgentId, merchant.id, now);
  if (!row) {
    throw jsonError(
      "MANDATE_REQUIRED",
      "An active standing mandate is required for live offer writes",
      403,
      { card_text: requiredCard(merchant.shopDomain), required: "new_mandate_or_amendment" },
    );
  }
  const caps = JSON.parse(row.capsJson) as MandateCaps;
  const selector = JSON.parse(row.selectorJson) as MandateSelector;
  const allow = JSON.parse(row.allowJson) as MandateAllow;
  const write = args.write;

  if (write.action === "publish" && allow.publish === false) {
    throw jsonError("MANDATE_EXCEEDED", "Mandate does not allow publish", 409, {
      card_text: exceededCard(merchant.shopDomain, "allow live publish", row.expiresAt),
      required: "new_mandate_or_amendment",
    });
  }
  if (write.action === "resume" && allow.resume === false) {
    throw jsonError("MANDATE_EXCEEDED", "Mandate does not allow resume", 409, {
      card_text: exceededCard(merchant.shopDomain, "allow resume", row.expiresAt),
      required: "new_mandate_or_amendment",
    });
  }
  if (write.action === "update" && allow.update_within_caps === false) {
    throw jsonError("MANDATE_EXCEEDED", "Mandate does not allow updates", 409, {
      card_text: exceededCard(merchant.shopDomain, "allow offer updates", row.expiresAt),
      required: "new_mandate_or_amendment",
    });
  }

  if (!selectorAllowed(selector, write)) {
    throw jsonError(
      "MANDATE_EXCEEDED",
      "Offer selector is outside the mandate selector",
      409,
      {
        card_text: exceededCard(
          merchant.shopDomain,
          "expand the mandate selector to cover this product",
          row.expiresAt,
        ),
        required: "new_mandate_or_amendment",
      },
    );
  }

  const rewardHit = capExceeded(write.rewardType, write.rewardAmount, caps.max_reward_flat, caps.max_reward_percent);
  if (rewardHit) {
    const pretty = write.rewardType === "percent" ? `${write.rewardAmount}%` : `$${write.rewardAmount}`;
    throw jsonError("MANDATE_EXCEEDED", `Reward ${pretty} exceeds mandate cap`, 409, {
      card_text: exceededCard(
        merchant.shopDomain,
        `raise the buyer reward cap to ${pretty}`,
        row.expiresAt,
      ),
      required: "new_mandate_or_amendment",
    });
  }

  if (write.finderFeeType && write.finderFeeAmount) {
    const feeHit = capExceeded(
      write.finderFeeType,
      write.finderFeeAmount,
      caps.max_finder_fee_flat,
      caps.max_finder_fee_percent,
    );
    if (feeHit) {
      throw jsonError("MANDATE_EXCEEDED", `Finder fee exceeds mandate cap`, 409, {
        card_text: exceededCard(merchant.shopDomain, "raise the finder fee cap", row.expiresAt),
        required: "new_mandate_or_amendment",
      });
    }
  }

  if (write.clawbackDays > caps.max_clawback_days) {
    throw jsonError(
      "MANDATE_EXCEEDED",
      `Clawback ${write.clawbackDays} days exceeds mandate cap ${caps.max_clawback_days}`,
      409,
      {
        card_text: exceededCard(merchant.shopDomain, "raise the clawback-day cap", row.expiresAt),
        required: "new_mandate_or_amendment",
      },
    );
  }

  const used = dailyRewardUsed(handle, args.sellerAgentId, merchant.id, now);
  const next = worstCaseReward(write);
  const projected = addMoney(used, next);
  if (compareMoney(projected, caps.max_daily_liability) > 0) {
    handle.db
      .update(mandates)
      .set({ status: "exceeded", updatedAt: now.toISOString() })
      .where(eq(mandates.id, row.id))
      .run();
    throw jsonError(
      "MANDATE_EXCEEDED",
      `Daily liability ${projected} would exceed cap ${caps.max_daily_liability}`,
      409,
      {
        card_text: exceededCard(merchant.shopDomain, "raise the daily liability cap", row.expiresAt),
        required: "new_mandate_or_amendment",
      },
    );
  }

  return row;
}

export function proposeMandate(
  handle: DbHandle,
  sellerAgentId: string,
  merchant: { id: string; shopDomain: string; name: string },
  input: ReturnType<typeof proposeMandateSchema.parse>,
  now = new Date(),
) {
  const expiresAt = resolveExpiresAt(input.expires_at, now);
  const caps = input.caps;
  const selector = input.selector;
  const allow = input.allow;
  const cardText = generateMandateCardText({
    shopName: merchant.name,
    shopDomain: merchant.shopDomain,
    caps,
    selector,
    expiresAt,
  });
  const id = newId("man_");
  const ts = now.toISOString();
  handle.db
    .insert(mandates)
    .values({
      id,
      sellerAgentId,
      merchantId: merchant.id,
      status: "proposed",
      expiresAt,
      allowJson: JSON.stringify(allow),
      capsJson: JSON.stringify(caps),
      selectorJson: JSON.stringify(selector),
      cardText,
      humanConfirmedAt: null,
      revokedAt: null,
      supersededBy: null,
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  const row = handle.db.select().from(mandates).where(eq(mandates.id, id)).get();
  if (!row) throw jsonError("INTERNAL", "Failed to store mandate", 500);
  return rowToMandate(row, merchant);
}

export function activateMandate(
  handle: DbHandle,
  sellerAgentId: string,
  mandateId: string,
  humanConfirmed: boolean,
  now = new Date(),
) {
  if (humanConfirmed !== true) {
    throw jsonError("CONFIRMATION_REQUIRED", "human_confirmed must be true after the human approved card_text", 400);
  }
  const row = handle.db.select().from(mandates).where(eq(mandates.id, mandateId)).get();
  if (!row || row.sellerAgentId !== sellerAgentId) {
    throw jsonError("MANDATE_NOT_FOUND", "Mandate not found", 404);
  }
  if (row.status === "revoked") throw jsonError("MANDATE_REVOKED", "Mandate is revoked", 409);
  if (new Date(row.expiresAt).getTime() <= now.getTime()) {
    handle.db
      .update(mandates)
      .set({ status: "expired", updatedAt: now.toISOString() })
      .where(eq(mandates.id, row.id))
      .run();
    throw jsonError("MANDATE_EXPIRED", "Mandate has expired", 410);
  }
  if (row.status !== "proposed" && row.status !== "active") {
    throw jsonError("MANDATE_INVALID", `Cannot activate mandate in status ${row.status}`, 409);
  }
  const others = handle.db
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.sellerAgentId, sellerAgentId),
        eq(mandates.merchantId, row.merchantId),
        eq(mandates.status, "active"),
      ),
    )
    .all();
  const ts = now.toISOString();
  for (const other of others) {
    if (other.id === row.id) continue;
    handle.db
      .update(mandates)
      .set({ status: "revoked", revokedAt: ts, supersededBy: row.id, updatedAt: ts })
      .where(eq(mandates.id, other.id))
      .run();
  }
  handle.db
    .update(mandates)
    .set({ status: "active", humanConfirmedAt: ts, updatedAt: ts })
    .where(eq(mandates.id, row.id))
    .run();
  const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
  const updated = handle.db.select().from(mandates).where(eq(mandates.id, row.id)).get();
  if (!updated || !merchant) throw jsonError("INTERNAL", "Mandate missing after activate", 500);
  return rowToMandate(updated, merchant);
}

export function revokeMandate(
  handle: DbHandle,
  mandateId: string,
  opts: { sellerAgentId?: string; pauseOffers?: boolean; demo?: boolean },
  now = new Date(),
) {
  const row = handle.db.select().from(mandates).where(eq(mandates.id, mandateId)).get();
  if (!row) throw jsonError("MANDATE_NOT_FOUND", "Mandate not found", 404);
  if (!opts.demo && opts.sellerAgentId && row.sellerAgentId !== opts.sellerAgentId) {
    throw jsonError("MANDATE_NOT_FOUND", "Mandate not found", 404);
  }
  const ts = now.toISOString();
  handle.db
    .update(mandates)
    .set({ status: "revoked", revokedAt: ts, updatedAt: ts })
    .where(eq(mandates.id, row.id))
    .run();
  if (opts.pauseOffers) {
    const live = handle.db.select().from(offers).where(eq(offers.mandateId, row.id)).all();
    for (const offer of live) {
      handle.db
        .update(offers)
        .set({ status: "paused", updatedAt: ts })
        .where(eq(offers.id, offer.id))
        .run();
    }
  }
  const merchant = handle.db.select().from(merchants).where(eq(merchants.id, row.merchantId)).get();
  const updated = handle.db.select().from(mandates).where(eq(mandates.id, row.id)).get();
  if (!updated || !merchant) throw jsonError("INTERNAL", "Mandate missing after revoke", 500);
  return rowToMandate(updated, merchant);
}
