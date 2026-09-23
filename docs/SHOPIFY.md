# Real Shopify shop

Demo Towels (`demo-towels.myshopify.com`, `gid://shopify/Product/1001`) is the seed. A first actual merchant is a **different** shop domain and a **real** product gid.

## Partners app (dashboard)

None of these may stay on localhost:

| Setting | Value |
|---|---|
| App URL | `https://www.offerlayer.io` |
| Allowed redirection URL | `https://www.offerlayer.io/auth/callback` |
| Webhook URI | `https://www.offerlayer.io/v1/webhooks/shopify` |
| Topics | `orders/paid`, `orders/cancelled`, `refunds/create` |
| API version | `2025-01` |

`shopify.app.toml` in this repo already matches.

## Host env

```
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...          # also the webhook signing secret
APP_URL=https://www.offerlayer.io
TOKEN_SECRET=...                # ≥16 chars; encrypts access tokens
DATABASE_URL=postgres://...     # durable (Neon). Do not use a disposable sqlite file on the host.
```

`SHOPIFY_APP_URL` and `PUBLIC_BASE_URL` are aliases; `APP_URL` wins over localhost leftovers.

## Install

1. Seller agent: `POST /v1/seller/links` with the real `*.myshopify.com` domain.
2. Human opens `install_url` (Shopify consent). Agent cannot skip this.
3. Callback verifies OAuth HMAC, exchanges the code, encrypts `access_token`, writes `seller_links` complete, registers webhooks.
4. `GET /v1/seller/shops` → `oauth_bound: true`.
5. `GET /v1/seller/shops/{id}/products` → real gids. Publish those, not `Product/1001`.
6. Tracked checkout URL is `https://SHOP/cart/{variantId}:1?attributes[agent_ref]={token}`.
7. A test order with that cart attribute fires `orders/paid` → `pending_hold`. Refunds during hold → `clawed_back`. Until the webhook fires, use the playground simulate purchase.

Without Partners credentials, `/auth/login` still boots. `POST /v1/simulate/shopify_oauth` (seller Bearer + `x-demo-key`) is the test stand-in and still requires a human yes in product flows.
