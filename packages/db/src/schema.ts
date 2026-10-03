import { sql } from "drizzle-orm";
import { bigint, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

/*
 * Conventions
 * - Money and percentages are decimal strings ("32.00", "10"). Never floats.
 * - Timestamps are ISO-8601 UTC strings ("2026-10-03T01:08:42.957Z"), which
 *   sort and compare correctly as text.
 * - Every table has row level security enabled and no policies. The app talks
 *   to the database only from the server as the table owner (which bypasses
 *   RLS), so Supabase's anon key and auto-generated REST API can read or write
 *   nothing.
 */

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  shopDomain: text("shop_domain").notNull().unique(),
  shopifyShopId: text("shopify_shop_id"),
  accessTokenEnc: text("access_token_enc"),
  name: text("name").notNull(),
  website: text("website"),
  catalogJson: text("catalog_json"),
  createdAt: text("created_at").notNull(),
}).enableRLS();

export const mandates = pgTable(
  "mandates",
  {
    id: text("id").primaryKey(),
    sellerAgentId: text("seller_agent_id")
      .notNull()
      .references(() => agents.id),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    status: text("status").notNull(),
    expiresAt: text("expires_at").notNull(),
    allowJson: text("allow_json").notNull(),
    capsJson: text("caps_json").notNull(),
    selectorJson: text("selector_json").notNull(),
    cardText: text("card_text").notNull(),
    humanConfirmedAt: text("human_confirmed_at"),
    revokedAt: text("revoked_at"),
    supersededBy: text("superseded_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_mandates_seller_merchant").on(t.sellerAgentId, t.merchantId, t.status)],
).enableRLS();

export const offers = pgTable(
  "offers",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    status: text("status").notNull(),
    selectorType: text("selector_type").notNull(),
    selectorIdsJson: text("selector_ids_json").notNull(),
    selectorTitle: text("selector_title"),
    listPrice: text("list_price"),
    selectorCurrency: text("selector_currency"),
    rewardType: text("reward_type").notNull(),
    rewardAmount: text("reward_amount").notNull(),
    rewardCurrency: text("reward_currency").notNull(),
    rewardRecipient: text("reward_recipient").notNull().default("buyer"),
    finderFeeType: text("finder_fee_type"),
    finderFeeAmount: text("finder_fee_amount"),
    finderFeeCurrency: text("finder_fee_currency"),
    finderFeeRecipient: text("finder_fee_recipient"),
    newCustomerOnly: integer("new_customer_only").notNull().default(0),
    shipToJson: text("ship_to_json"),
    maxPerPrincipalPerDay: integer("max_per_principal_per_day"),
    maxUnitsPerOrder: integer("max_units_per_order"),
    clawbackDays: integer("clawback_days").notNull().default(14),
    disclosure: text("disclosure").notNull(),
    checkoutUrlTemplate: text("checkout_url_template").notNull(),
    ucp: integer("ucp").notNull().default(0),
    mandateId: text("mandate_id").references(() => mandates.id),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_offers_merchant_status").on(t.merchantId, t.status),
    index("idx_offers_status").on(t.status),
    index("idx_offers_mandate").on(t.mandateId),
  ],
).enableRLS();

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publicKey: text("public_key"),
    apiKeyHash: text("api_key_hash").notNull(),
    status: text("status").notNull().default("active"),
    role: text("role").notNull().default("shopper"),
    /** Per-key overrides for checkout rate limits; null uses the env default. */
    ratePerMinute: integer("rate_per_minute"),
    ratePerDay: integer("rate_per_day"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_agents_api_key_hash").on(t.apiKeyHash)],
).enableRLS();

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    emailHash: text("email_hash").notNull(),
    shopifyCustomerId: text("shopify_customer_id"),
    firstSeenAt: text("first_seen_at").notNull(),
  },
  (t) => [uniqueIndex("idx_principals_merchant_email").on(t.merchantId, t.emailHash)],
).enableRLS();

export const tokens = pgTable(
  "tokens",
  {
    tokenId: text("token_id").primaryKey(),
    offerId: text("offer_id")
      .notNull()
      .references(() => offers.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    principalHash: text("principal_hash").notNull(),
    referrerAgentId: text("referrer_agent_id"),
    /** Unix seconds. */
    exp: bigint("exp", { mode: "number" }).notNull(),
    nonce: text("nonce").notNull(),
    rawJws: text("raw_jws").notNull(),
    consumedAt: text("consumed_at"),
    /** The agent key that asked for this token (rate limits count against it). */
    issuedBy: text("issued_by"),
    discountCode: text("discount_code"),
    /** Shopify DiscountCodeNode gid, so the cleanup job can delete unused codes. */
    discountNodeId: text("discount_node_id"),
    discountDeletedAt: text("discount_deleted_at"),
    discountCleanupError: text("discount_cleanup_error"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_tokens_nonce").on(t.nonce),
    uniqueIndex("idx_tokens_raw").on(t.rawJws),
    uniqueIndex("idx_tokens_discount_node").on(t.discountNodeId),
    index("idx_tokens_issued_by").on(t.issuedBy, t.createdAt),
    index("idx_tokens_offer_created").on(t.offerId, t.createdAt),
    index("idx_tokens_principal").on(t.principalHash),
    index("idx_tokens_open_discounts").on(t.exp).where(
      // Partial index for the cleanup job's scan.
      sqlOpenDiscounts(),
    ),
  ],
).enableRLS();

export const ordersExt = pgTable(
  "orders_ext",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    shopifyOrderId: text("shopify_order_id"),
    tokenId: text("token_id")
      .notNull()
      .references(() => tokens.tokenId),
    /** Attributed amount: the offer's eligible lines, after discounts. */
    total: text("total").notNull(),
    /** The whole order's total, for reference only. */
    orderTotal: text("order_total"),
    /** JSON [{ id, amount }] of the line items counted in `total`. */
    attributedLinesJson: text("attributed_lines_json"),
    /** Sum of attributed amounts refunded so far. */
    refundedTotal: text("refunded_total").notNull().default("0.00"),
    currency: text("currency").notNull(),
    /** HMAC of the normalized order email (never the raw email). */
    emailHash: text("email_hash"),
    status: text("status").notNull(),
    paidAt: text("paid_at").notNull(),
    holdUntil: text("hold_until").notNull(),
    clawedAt: text("clawed_at"),
  },
  (t) => [
    uniqueIndex("idx_orders_shopify").on(t.shopifyOrderId),
    uniqueIndex("idx_orders_token").on(t.tokenId),
    index("idx_orders_merchant_paid").on(t.merchantId, t.paidAt),
    index("idx_orders_email").on(t.emailHash),
  ],
).enableRLS();

export const orderRefunds = pgTable(
  "order_refunds",
  {
    id: text("id").primaryKey(),
    orderExtId: text("order_ext_id")
      .notNull()
      .references(() => ordersExt.id),
    shopifyRefundId: text("shopify_refund_id").notNull(),
    amount: text("amount").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_order_refunds_unique").on(t.orderExtId, t.shopifyRefundId)],
).enableRLS();

/** One row per Shopify delivery (X-Shopify-Webhook-Id); replays return the stored result. */
export const webhookEvents = pgTable("webhook_events", {
  webhookId: text("webhook_id").primaryKey(),
  topic: text("topic").notNull(),
  shopDomain: text("shop_domain"),
  resultJson: text("result_json").notNull(),
  receivedAt: text("received_at").notNull(),
}).enableRLS();

export const payouts = pgTable(
  "payouts",
  {
    id: text("id").primaryKey(),
    orderExtId: text("order_ext_id")
      .notNull()
      .references(() => ordersExt.id),
    party: text("party").notNull(),
    agentId: text("agent_id"),
    amount: text("amount").notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
  },
  (t) => [index("idx_payouts_order").on(t.orderExtId)],
).enableRLS();

export const sellerLinks = pgTable("seller_links", {
  id: text("id").primaryKey(),
  sellerAgentId: text("seller_agent_id")
    .notNull()
    .references(() => agents.id),
  shopDomain: text("shop_domain"),
  status: text("status").notNull(),
  installUrl: text("install_url").notNull(),
  nonce: text("nonce").notNull(),
  expiresAt: text("expires_at").notNull(),
  merchantId: text("merchant_id").references(() => merchants.id),
  createdAt: text("created_at").notNull(),
}).enableRLS();

export const shopGrants = pgTable(
  "shop_grants",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    sellerAgentId: text("seller_agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_shop_grants_unique").on(t.merchantId, t.sellerAgentId)],
).enableRLS();

function sqlOpenDiscounts() {
  return sql`discount_node_id IS NOT NULL AND discount_deleted_at IS NULL AND consumed_at IS NULL`;
}

export const schema = {
  merchants,
  offers,
  agents,
  principals,
  tokens,
  ordersExt,
  orderRefunds,
  webhookEvents,
  payouts,
  sellerLinks,
  shopGrants,
  mandates,
};

/** Every table, in an order that is safe to TRUNCATE ... CASCADE in one statement. */
export const TABLE_NAMES = [
  "webhook_events",
  "order_refunds",
  "payouts",
  "orders_ext",
  "principals",
  "tokens",
  "offers",
  "mandates",
  "shop_grants",
  "seller_links",
  "agents",
  "merchants",
] as const;
