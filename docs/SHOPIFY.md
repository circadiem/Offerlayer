# Real Shopify shop

Demo Towels (`demo-towels.myshopify.com`, `gid://shopify/Product/1001`) is the seed. A first actual merchant is a **different** shop domain and a **real** product gid.

## Partners app (dashboard)

None of these may stay on localhost:

| Setting | Value |
|---|---|
| App URL | `https://api.offerlayer.io` |
| Allowed redirection URL | `https://api.offerlayer.io/auth/callback` |
| Webhook URI | `https://api.offerlayer.io/v1/webhooks/shopify` |
| Topics | `orders/paid`, `orders/cancelled`, `refunds/create`, `app/uninstalled` |
| Compliance topics | `customers/data_request`, `customers/redact`, `shop/redact` |
| API version | `2026-10` (one constant, `SHOPIFY_API_VERSION` in `apps/api/src/shopify-admin.ts`) |

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

## Discount codes

Each checkout gets one code (`OL…`, titled `Offerlayer · agent checkout · <offer id>`),
usable once, ending when the checkout expires. Its scope follows the offer:
products and variants, a collection, or the whole shop. An offer that cannot be
scoped (for example a product offer with no Shopify gids) gets no code rather
than a store-wide one. By default the code does not combine with other
discounts; a seller can set `combines_with` on the offer.

Attribution: on `orders/paid` the code itself identifies the checkout, so it
works even when a checkout path drops cart attributes. `agent_ref` is the
fallback.

## Uninstall and privacy webhooks

All arrive at `/v1/webhooks/shopify`, are HMAC-verified, and act on the shop
named in the signed payload (never the unsigned `X-Shopify-Shop-Domain` header).

| Topic | What happens |
| --- | --- |
| `app/uninstalled` | Live offers paused, access token deleted, open codes left to expire (Shopify revokes our token, so they cannot be deleted) |
| `customers/data_request` | A row in `compliance_requests` lists what we hold for that customer: attributed order ids and amounts. No name, address, phone, or raw email is stored. An operator sends it to the merchant within 30 days. |
| `customers/redact` | The customer's email hash is removed from orders, principals, and checkout tokens |
| `shop/redact` | Every row for the shop is deleted |

## Protected customer data

Order webhooks contain customer data. Attribution does not need any of it:
the discount code or `agent_ref` identifies the checkout. The order email is
used only to match per-shopper daily caps with the agent's `principal_ref`,
and reading it requires **Level 2** protected customer data access. Without
Level 2 approval Shopify redacts the email and caps rely on `principal_ref`
alone. Recommendation for launch: request Level 1, state that only order ids,
line items, and totals are processed, and revisit Level 2 only if cap evasion
shows up.

## Webhook subscriptions: app config vs API

`shopify.app.toml` declares the subscriptions (app-wide, deployed with
`shopify app deploy`). The OAuth callback also registers per-shop
subscriptions through the API, which predates the TOML. Once the TOML config
is deployed, remove the per-shop registration to avoid duplicate deliveries
(duplicates are harmless: a second delivery of the same order is rejected as
`TOKEN_CONSUMED`).
