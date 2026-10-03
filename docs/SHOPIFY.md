# Real Shopify shop

Demo Towels (`demo-towels.myshopify.com`, `gid://shopify/Product/1001`) is the seed. A first actual merchant is a **different** shop domain and a **real** product gid.

## Partners app (dashboard)

None of these may stay on localhost:

| Setting | Value |
|---|---|
| App URL | `https://api.offerlayer.io` |
| Allowed redirection URL | `https://api.offerlayer.io/auth/callback` |
| Webhook URI | `https://api.offerlayer.io/v1/webhooks/shopify` |
| Topics | `orders/paid`, `orders/cancelled`, `refunds/create` |
| API version | `2025-01` |

`shopify.app.toml` in this repo already matches.

## Host env

```
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...          # also the webhook signing secret
API_URL=https://api.offerlayer.io  # optional; this is the production default
ACCESS_TOKEN_ENCRYPTION_KEY=... # 32+ chars; encrypts access tokens (docs/SECRETS.md)
DATABASE_URL=postgres://...     # Supabase transaction pooler; see docs/DATABASE.md
```

The app's OAuth routes live on the API host, so the Shopify app URL defaults to `API_URL`. Set `SHOPIFY_APP_URL` only if the app is served elsewhere. Install links, the OAuth redirect, and webhook URLs always come from configuration, never from a request's Host header.

## Install

1. Seller agent: `POST /v1/seller/links` with the real `*.myshopify.com` domain.
2. Human opens `install_url` (Shopify consent). Agent cannot skip this.
3. Callback verifies OAuth HMAC, exchanges the code, encrypts `access_token`, writes `seller_links` complete, registers webhooks.
4. `GET /v1/seller/shops` → `oauth_bound: true`.
5. `GET /v1/seller/shops/{id}/products` → real gids. Publish those, not `Product/1001`.
6. Tracked checkout URL is `https://SHOP/cart/{variantId}:1?attributes[agent_ref]={token}`.
7. A test order with that cart attribute fires `orders/paid` → `pending_hold`. A full refund during the hold → `clawed_back`; partial refunds reduce the attributed amount.

Without Partner credentials, `/auth/login` still boots as a page. In demo mode only, `POST /v1/simulate/shopify_oauth` (seller Bearer + `x-demo-key`) stands in for OAuth; production returns 404 for it.
