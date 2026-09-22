-- v0.2 standing mandates. Applied by packages/db/src/client.ts migrate().
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  seller_agent_id TEXT NOT NULL REFERENCES agents(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  allow_json TEXT NOT NULL,
  caps_json TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  card_text TEXT NOT NULL,
  human_confirmed_at TEXT,
  revoked_at TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE offers ADD COLUMN mandate_id TEXT;
