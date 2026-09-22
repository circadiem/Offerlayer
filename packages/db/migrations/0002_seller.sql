-- v0.1 seller-agent handoff. Applied by packages/db/src/client.ts migrate().
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'shopper';

CREATE TABLE IF NOT EXISTS seller_links (
  id TEXT PRIMARY KEY,
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  shop_domain TEXT,
  status TEXT NOT NULL,
  install_url TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  merchant_id TEXT REFERENCES merchants(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_grants (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, seller_agent_id)
);
