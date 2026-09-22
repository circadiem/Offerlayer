# Offerlayer v0.1 acceptance

Assume v0 `docs/ACCEPTANCE.md` still passes. Then:

```bash
pnpm seed
pnpm test
pnpm demo:seller
```

## Roles

- [ ] Seed prints both `agt_sell_...` (seller) and `agt_live_...` / demo shopper key.
- [ ] Seller bearer on `POST /v1/checkouts` → 403 `ROLE_MISMATCH`.
- [ ] Shopper bearer on `POST /v1/seller/offers` → 403 `ROLE_MISMATCH`.

## Link + grant

- [ ] `POST /v1/seller/links` as seller → `pending_link_id`, `install_url`, `disclosure`.
- [ ] `POST /v1/simulate/connect_shop` (or complete) attaches `demo-towels.myshopify.com` to that seller.
- [ ] `GET /v1/seller/shops` returns that shop.
- [ ] A second seller agent without a grant cannot PATCH the first seller’s offer → 403.

## Offer CRUD

- [ ] Seller creates live towel offer → `GET /v1/offers?q=towel&ship_to=US` includes it.
- [ ] Created offer always has `disclosure` ≥ 16 chars.
- [ ] Pause → public search hides or marks not live; resume restores.

## Performance

- [ ] After shopper simulate purchase on that offer, `GET /v1/seller/offers/:id/performance` shows `attributed_orders >= 1` and pending_hold GMV `"32.00"`.

## MCP

- [ ] Seller key exposes `create_shop_link`, `create_offer`, `list_my_offers`, `offer_performance` and does not expose `create_tracked_checkout`.
- [ ] Shopper key exposes v0 shopper tools and does not expose `create_offer`.
- [ ] Seller tool descriptions tell the model to show disclosure and wait for human yes before live.

## Shopify

- [ ] OAuth start accepts / persists `seller_link` and complete endpoint is called after auth.
- [ ] If Shopify creds missing, demo path still green; document the skip.

## Demo

- [ ] `pnpm demo:seller` exit 0. Prints seller publish → shopper checkout → pending_hold → performance row.

## Hygiene

- [ ] Seller keys stored hashed. No raw keys in default logs.
- [ ] `CONNECTOR.md` contains the seller recipe.
