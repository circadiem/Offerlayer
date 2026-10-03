# Offerlayer v0.3 acceptance — Shop Pay / Muse checkout attach

Run:

```bash
pnpm test
pnpm demo:agentic
```

Do not rewrite mandates, roles, HMAC `olt_` tokens, or the hold/clear machine.

## Checkout response

- [ ] `POST /v1/checkouts` 201 includes `token`, `offer_id`, `disclosure`, and `checkout.permalink` + `checkout.agentic`.
- [ ] `checkout_url` remains the permalink (back-compat).
- [ ] Permalink contains `attributes[agent_ref]=olt_…`, `utm_source=offerlayer`, `utm_medium=agentic_commerce`, `utm_campaign=off_…`, `utm_content=olt_…`.
- [ ] Permalink on a `*.myshopify.com` shop also has `payment=shop_pay`.
- [ ] Seed Product/1001: `agentic.line_items` omitted and `agentic.warning` is `NO_VARIANT_GID`.
- [ ] Real variant gid (or cart numeric id distinct from product gid): `agentic.line_items[0].item.id` is `gid://shopify/ProductVariant/…`.
- [ ] `agentic.attributes` includes `agent_ref` and `offerlayer_offer`. `agentic.note` contains the token.
- [ ] `GET /v1/offers/:id` still returns `checkout.ucp` + `tracked_url_template`. `ucp` is true only after a real Shopify bind (`access_token` stored).

## Webhooks

- [ ] `orders/paid` with `note_attributes` `agent_ref=olt_…` → `pending_hold`.
- [ ] `orders/paid` with only `landing_site: "/?utm_content=olt_…"` → `pending_hold`.
- [ ] `orders/paid` with order `note` containing `olt_…` → `pending_hold`.
- [ ] `orders/paid` with line-item property `agent_ref` → `pending_hold`.
- [ ] `orders/paid` with `offerlayer_offer` but no token → ignored, no conversion. Log `UNATTRIBUTED_PAID_ORDER`.
- [ ] Refund / cancel during hold still claws back.

## Connector / demo

- [ ] Shopper CONNECTOR recipe prefers `checkout.agentic` for Muse / Shop Pay; permalink if the tool only takes a URL. No second unpaid cart.
- [ ] `pnpm demo:agentic` prints permalink + agentic JSON, attributes two paid fixtures, exits 0.

## What must not change

- [ ] Mandate math, roles (`ROLE_MISMATCH`), token HMAC, payout stubs unchanged.
- [ ] No hosted Offerlayer checkout page. No second payment rail.
