# Offerlayer — Muse / agent connector brief

Read this whole file before writing any integration code.

Offerlayer is not a store and not a product catalog. Shopify Catalog (and Muse’s existing shopping path) still find products. Offerlayer answers one extra question at checkout time:

> Does this merchant fund a disclosed buyer reward (and optional agent finder fee) if this order is attributed to me?

You bring the shopper context. We bring offer discovery, a signed `agent_ref` token, and conversion status.

## Base URL

Production: `https://offerlayer.vercel.app`

`https://offerlayer.grok.me` is a separate publish and is not this API.

Auth is **Bearer only**. Do not HMAC-sign Offerlayer HTTP requests. Shopify HMAC is for Shopify webhooks and OAuth callbacks, not for Muse.

## Two credentials — never one key for both

Put each in its **own** Muse vault / thread / connector:

| Vault | Value | Role |
|---|---|---|
| `OFFERLAYER_SELLER_KEY` | `agt_sell_…` | Connect shops, mandates, publish offers, read performance |
| `OFFERLAYER_AGENT_KEY` | `agt_live_…` | Search, disclose, attach checkout, read conversion |

The operator generates these. They are not printed on the website. The old public seed strings do not work on `offerlayer.vercel.app`.

```
OFFERLAYER_SELLER_KEY=agt_sell_…
OFFERLAYER_AGENT_KEY=agt_live_…
```

Cross-role calls return `403 ROLE_MISMATCH`. A seller key cannot checkout. A shopper key cannot publish.

## Allowed hosts

- `https://offerlayer.vercel.app` for the API key on this deployment.
- Merchant `checkout_url` hosts returned by the API (Shopify shop domains). Send the `olt_…` token there, never the agent key.

## Hard rules

1. Always show `disclosure` to the human in the same turn you present the product or ask for purchase approval.
2. Prefer the offer that matches the human’s constraints. Do not default to the largest finder fee.
3. Never complete a purchase without the human’s approval. There is no spend mandate that skips Muse’s purchase card.
4. Put the token on checkout exactly as returned (`checkout.agentic` into Muse / Shop Pay, or `checkout.permalink` / `checkout_url` if the tool only takes a URL). Do not mint your own.
5. `pending_hold` is not paid. Do not promise it has cleared.
6. Set `human_confirmed: true` only after the human approved the exact `card_text` in this turn.
7. “Always allow Offerlayer” does not let you exceed mandate caps.
8. Do not pretend Offerlayer is Shop Pay or host a checkout page.
9. Do not drop the token because the native Muse / Shop Pay cart already started.
10. Do not attribute an order that has no `olt_` token.

---

## Seller recipe (this thread, seller key only)

Permission model: Shopify OAuth once per shop. Mandate once per policy. Then work inside the box.

Muse approval cards map like this:

| Muse choice | Offerlayer |
|---|---|
| Allow once | Activate mandate with short `expires_at`, or confirm a single live publish |
| Allow for this task | Activate mandate covering this selling task |
| Allow for this connector / Always allow | Activate mandate; still cannot exceed caps |
| Deny | Do not call `activate_mandate` |

### Connect a shop (human in the browser)

1. `POST /v1/seller/links` `{"shop_domain":"YOUR-SHOP.myshopify.com"}`
   Show `install_url` and `disclosure` verbatim. The host is the base URL above.
2. The human opens `install_url` and approves Shopify OAuth. There is no agent-only install.
   - When Partners credentials are set, that URL **redirects to Shopify**. `GET /auth/callback` verifies HMAC, stores the access token, registers `orders/paid` / `orders/cancelled` / `refunds/create`, and `POST`s the seller link complete.
   - Demo without Partners: after the human says yes, `POST /v1/seller/links/{id}/complete` with the seller Bearer, or `POST /v1/simulate/connect_shop` / `POST /v1/simulate/shopify_oauth` (still needs the human + `x-demo-key`).
3. `GET /v1/seller/shops` — must be non-empty. `oauth_bound: true` means a Shopify token is stored.

### Mandate, then publish a real product

4. `GET /v1/seller/shops/{merchant_id}/products` — use a **real product gid**, not `gid://shopify/Product/1001` (that is the demo seed).
5. `POST /v1/seller/mandates` with that gid and conservative caps. Show returned `card_text` verbatim.
6. After the human approves that exact text: `POST /v1/seller/mandates/{id}/activate` `{"human_confirmed": true}`.
7. `POST /v1/seller/offers` status `live` using the product gid **and** the catalog `checkout_template` (variant cart URL with `attributes[agent_ref]={token}`).
8. On `MANDATE_REQUIRED` or `MANDATE_EXCEEDED`, show `error.card_text` and propose an amendment. Do not retry in a loop.

Unattended while a mandate is active: pause / resume / publish a SKU already in the selector at or below caps / read performance.

Stop and ask: first shop bind, first mandate or any cap increase, selector expansion, anything flagged `MANDATE_EXCEEDED`.

Revoke does **not** auto-pause live offers unless `pause_offers=true`.

---

## Shopper recipe (other thread, agent key only)

Shopify Catalog and Muse × Shop Pay find the product and take payment. Offerlayer stamps a signed `olt_` token onto that checkout so the funded offer can attribute. Do not open a competing cart.

1. Discover the product however Muse already does (Catalog / Shop Pay). Offerlayer is not the catalog.
2. `GET /v1/offers` for that shop + product (`shop`, `product_id`, or `q`).
3. Show `disclosure` on the **same** Muse purchase card as the Shop Pay total. Wait for purchase approval **every time**.
4. `POST /v1/checkouts` `{"offer_id":"..."}` with the shopper key.
5. Prefer native Muse / Shop Pay checkout. Pass `checkout.agentic.attributes`, `note`, and `utm` into that flow if the tool allows custom attributes. If the tool only takes a URL, use `checkout.permalink` (cart URL with `attributes[agent_ref]`, `payment=shop_pay`, and utm).
6. Do not open a second unpaid browser cart if Muse already started Shop Pay.

`pending_hold` is still not paid. Attribution arrives from Shopify `orders/paid` (note attributes, order note, landing-site `utm_content`, or line-item `agent_ref`) — or from playground `simulate/purchase` until the webhook fires.

`GET /v1/conversions/{token}` → `pending_hold` is not paid.

Seller: `GET /v1/seller/offers/{id}/performance` → attributed orders.

If Shopify’s public UCP `create_checkout` cannot take note attributes from an untrusted third party, use `checkout.permalink` plus webhook matching on `landing_site` / order note. Do not invent a second payment rail.

### Endpoints

Public: `GET /health`, `GET /v1/offers`, `GET /v1/offers/{id}`, `GET /.well-known/agent-offers.json`

Shopper Bearer: `POST /v1/checkouts`, `POST /v1/refer`, `GET /v1/conversions/{token}`

Seller Bearer: `/v1/seller/links`, `/v1/seller/shops`, `/v1/seller/shops/{id}/products`, `/v1/seller/offers`, `/v1/seller/mandates`, `/v1/seller/offers/{id}/performance`

### MCP

Configure **one** role per process:

```
OFFERLAYER_SELLER_KEY=agt_sell_...
# or
OFFERLAYER_AGENT_KEY=agt_live_...
```

Seller tools include `list_shop_products`. Shopper tools never see seller routes.

Official Muse directory submission is optional later. This custom connector is enough to work.
