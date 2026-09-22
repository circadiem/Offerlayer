import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const merchants = sqliteTable("merchants", {
  id: text("id").primaryKey(),
  shopDomain: text("shop_domain").notNull().unique(),
  shopifyShopId: text("shopify_shop_id"),
  accessTokenEnc: text("access_token_enc"),
  name: text("name").notNull(),
  website: text("website"),
  catalogJson: text("catalog_json"),
  createdAt: text("created_at").notNull(),
});

export const offers = sqliteTable(
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
    mandateId: text("mandate_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_offers_merchant_status").on(t.merchantId, t.status)],
);

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key"),
  apiKeyHash: text("api_key_hash").notNull(),
  status: text("status").notNull().default("active"),
  role: text("role").notNull().default("shopper"),
  createdAt: text("created_at").notNull(),
});

export const principals = sqliteTable("principals", {
  id: text("id").primaryKey(),
  merchantId: text("merchant_id")
    .notNull()
    .references(() => merchants.id),
  emailHash: text("email_hash").notNull(),
  shopifyCustomerId: text("shopify_customer_id"),
  firstSeenAt: text("first_seen_at").notNull(),
});

export const tokens = sqliteTable(
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
    exp: integer("exp").notNull(),
    nonce: text("nonce").notNull(),
    rawJws: text("raw_jws").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_tokens_nonce").on(t.nonce)],
);

export const ordersExt = sqliteTable(
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
    total: text("total").notNull(),
    currency: text("currency").notNull(),
    emailHash: text("email_hash"),
    status: text("status").notNull(),
    paidAt: text("paid_at").notNull(),
    holdUntil: text("hold_until").notNull(),
    clawedAt: text("clawed_at"),
  },
  (t) => [uniqueIndex("idx_orders_shopify").on(t.shopifyOrderId)],
);

export const payouts = sqliteTable("payouts", {
  id: text("id").primaryKey(),
  orderExtId: text("order_ext_id")
    .notNull()
    .references(() => ordersExt.id),
  party: text("party").notNull(),
  agentId: text("agent_id"),
  amount: text("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
});

export const sellerLinks = sqliteTable("seller_links", {
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
});

export const shopGrants = sqliteTable(
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
);

export const mandates = sqliteTable(
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
);

export const schema = {
  merchants,
  offers,
  agents,
  principals,
  tokens,
  ordersExt,
  payouts,
  sellerLinks,
  shopGrants,
  mandates,
};
