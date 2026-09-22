export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS merchants (
  id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL UNIQUE,
  shopify_shop_id TEXT,
  access_token_enc TEXT,
  name TEXT NOT NULL,
  website TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  status TEXT NOT NULL,
  selector_type TEXT NOT NULL,
  selector_ids_json TEXT NOT NULL,
  selector_title TEXT,
  list_price TEXT,
  selector_currency TEXT,
  reward_type TEXT NOT NULL,
  reward_amount TEXT NOT NULL,
  reward_currency TEXT NOT NULL,
  reward_recipient TEXT NOT NULL DEFAULT 'buyer',
  finder_fee_type TEXT,
  finder_fee_amount TEXT,
  finder_fee_currency TEXT,
  finder_fee_recipient TEXT,
  new_customer_only INTEGER NOT NULL DEFAULT 0,
  ship_to_json TEXT,
  max_per_principal_per_day INTEGER,
  max_units_per_order INTEGER,
  clawback_days INTEGER NOT NULL DEFAULT 14,
  disclosure TEXT NOT NULL,
  checkout_url_template TEXT NOT NULL,
  ucp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offers_merchant_status ON offers(merchant_id, status);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT,
  api_key_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  email_hash TEXT NOT NULL,
  shopify_customer_id TEXT,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offers(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  principal_hash TEXT NOT NULL,
  referrer_agent_id TEXT,
  exp INTEGER NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  raw_jws TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders_ext (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  shopify_order_id TEXT,
  token_id TEXT NOT NULL REFERENCES tokens(token_id),
  total TEXT NOT NULL,
  currency TEXT NOT NULL,
  email_hash TEXT,
  status TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  hold_until TEXT NOT NULL,
  clawed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify ON orders_ext(shopify_order_id) WHERE shopify_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  order_ext_id TEXT NOT NULL REFERENCES orders_ext(id),
  party TEXT NOT NULL,
  agent_id TEXT,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL
);
`;
