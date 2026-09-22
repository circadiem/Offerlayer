# Real Shopify shop acceptance

v0–v0.2 still pass. Then:

```bash
pnpm test
pnpm demo:shopify
```

## OAuth

- [ ] `SHOPIFY_API_KEY` set → `GET /auth/login?shop=…&seller_link=lnk_…` 302s to Shopify authorize. Redirect URI is `https://offerlayer.grok.me/auth/callback`. No localhost.
- [ ] `SHOPIFY_API_KEY` empty → `/auth/login` is still the human HTML page.
- [ ] Callback with bad HMAC → 401 `HMAC_INVALID`.
- [ ] Callback with valid HMAC (fixture) stores `access_token_enc` (AES, not plaintext), sets `shopify_shop_id`, completes the seller link, registers webhooks.

## Catalog

- [ ] `GET /v1/seller/shops/{id}/products` after simulated or real OAuth returns a gid that is **not** `Product/1001`.
- [ ] Live offer checkout_template uses `/cart/{variant}:1?attributes[agent_ref]={token}`.

## Webhooks

- [ ] `orders/paid` with `note_attributes` or line-item `agent_ref=olt_…` → `pending_hold`.
- [ ] `refunds/create` during hold → `clawed_back`.
- [ ] Until a webhook fires, conversion stays simulated (`POST /v1/simulate/purchase`).

## Muse

- [ ] CONNECTOR.md: Bearer only, two vaults, mandate recipe, real product gid, purchase approval every time.
- [ ] MCP `list_shop_products` is a seller tool. Shopper key cannot call it (ROLE_MISMATCH on seller routes).

## Demo

- [ ] `pnpm demo:shopify` exit 0: towels-dev shop, Product/9001001, webhook pending_hold, refund clawback.
