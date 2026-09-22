-- Cached catalog from Shopify OAuth / simulate oauth. Applied by packages/db/src/client.ts migrate().
ALTER TABLE merchants ADD COLUMN catalog_json TEXT;
