# Offerlayer — Shop Pay / Muse checkout attach (v0.3 addendum)

This amends the **shopper** recipe in CONNECTOR.md. Seller recipe does not change.

Shopify Catalog and Muse × Shop Pay find the product and take payment. Offerlayer stamps a signed `olt_` token onto that checkout so the funded offer can attribute. Do not open a competing cart.

## Shopper recipe (Shop Pay)

1. Discover the product however Muse already does (Catalog / Shop Pay). Offerlayer is not the catalog.
2. `GET /v1/offers` for that shop + product (`shop`, `product_id`, or `q`).
3. Show `disclosure` on the **same** Muse purchase card as the Shop Pay total.
4. `POST /v1/checkouts` `{"offer_id":"..."}` with the shopper key.
5. Prefer native Muse / Shop Pay checkout. Pass `checkout.agentic.attributes`, `note`, and `utm` into that flow if the tool allows custom attributes. If the tool only takes a URL, use `checkout.permalink` (cart URL with `attributes[agent_ref]`, `payment=shop_pay`, and utm).
6. Do not open a second unpaid browser cart if Muse already started Shop Pay.

`pending_hold` is still not paid. Attribution arrives from Shopify `orders/paid` (note attributes, order note, landing-site `utm_content`, or line-item `agent_ref`) — or from playground `simulate/purchase` until the webhook fires.

## What you must never do

- Pretend Offerlayer is Shop Pay or host a checkout page.
- Drop the token because the native cart “already started”.
- Attribute an order that has no `olt_` token.
