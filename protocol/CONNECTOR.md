# Offerlayer integration guide

For developers connecting an AI shopping agent, or a merchant's own agent, to
Offerlayer. Notes for specific agent platforms are in `docs/integrations/`.

Offerlayer is not a store or a product catalog. Agents still find products
the way they already do. Offerlayer answers one extra question at checkout:

> Does this merchant offer a discount, disclosed to the shopper, if this
> order comes through an AI agent?

If yes, the agent creates a single-use checkout and hands the shopper a cart
with the discount already applied.

## Hosts

| Purpose | URL |
| --- | --- |
| API and webhooks | `https://api.offerlayer.io` |
| Remote MCP server | `https://mcp.offerlayer.io` |
| Docs | `https://www.offerlayer.io` |

API auth is `Authorization: Bearer <key>`. Do not HMAC-sign Offerlayer
requests; HMAC is only for Shopify's own webhooks and OAuth callbacks.

## Keys

A key has exactly one role. Keep them in separate configurations:

| Variable | Prefix | Role |
| --- | --- | --- |
| `OFFERLAYER_AGENT_KEY` | `agt_live_…` | Shopper: search offers, create checkouts, read conversions |
| `OFFERLAYER_SELLER_KEY` | `agt_sell_…` | Seller: connect shops, set limits, publish offers, read results |

Using a key for the other role returns `403 ROLE_MISMATCH`.

## Rules every integration must follow

1. Show the offer's `disclosure` to the shopper before payment, alongside the
   price they will pay.
2. Get the shopper's explicit approval for every purchase. Never auto-buy.
3. Pass the checkout exactly as returned. Do not mint codes or tokens.
4. `pending_hold` means paid but inside the refund window. Do not describe
   it as final.
5. Choose offers on what fits the shopper, not on what the merchant pays.
6. Seller writes that need a human: confirm only after the human approved
   the exact `card_text` returned by the API.

## Shopper flow

1. Find the product the way your agent already does.
2. `GET /v1/offers?shop=…&product_id=…` (or `q=`). Public, no key needed.
3. Show `disclosure` with the total. Wait for approval.
4. `POST /v1/checkouts` `{"offer_id": "…", "principal_ref": "<stable shopper id or email>"}`
   with the shopper key. `principal_ref` is hashed on our side and lets the
   merchant's per-shopper limits work; without it, stricter anonymous limits apply.
5. Send the shopper to `checkout.permalink`. It is a cart link carrying the
   single-use discount code and the `agent_ref` attribute. If your checkout
   tool takes cart attributes instead of a URL, pass `checkout.agentic.attributes`
   and `checkout.agentic.note`.
6. `GET /v1/conversions/{token}` to see what happened.

Checkouts expire after 30 minutes. Limits per key and per offer return
`429` with `retry_after_seconds`.

## Seller flow

1. `POST /v1/seller/links` `{"shop_domain": "your-shop.myshopify.com"}`.
   Show `install_url` and `disclosure` to the human.
2. The human opens `install_url` and approves the app in Shopify. There is no
   way to connect a shop without that approval.
3. `GET /v1/seller/shops` and `GET /v1/seller/shops/{id}/products`.
4. `POST /v1/seller/mandates` with caps and a selector. Show `card_text`.
5. After the human approves that text: `POST /v1/seller/mandates/{id}/activate`
   `{"human_confirmed": true}`.
6. `POST /v1/seller/offers` with `status: "live"`.
7. On `MANDATE_REQUIRED` or `MANDATE_EXCEEDED`, show `error.card_text` and
   propose a change. Do not retry in a loop.

Limits are re-checked at every checkout, so lowering a cap or revoking a
mandate takes effect immediately.

## Endpoints

- Public: `GET /health`, `GET /v1/offers`, `GET /v1/offers/{id}`, `GET /.well-known/agent-offers.json`
- Shopper key: `POST /v1/checkouts`, `POST /v1/refer`, `GET /v1/conversions/{token}`
- Seller key: `/v1/seller/links`, `/v1/seller/shops`, `/v1/seller/shops/{id}/products`,
  `/v1/seller/offers`, `/v1/seller/mandates`, `/v1/seller/offers/{id}/performance`

The full contract is `protocol/openapi.yaml`.

## MCP

Run one role per process:

```
OFFERLAYER_URL=https://api.offerlayer.io OFFERLAYER_AGENT_KEY=agt_live_… pnpm mcp
# or
OFFERLAYER_URL=https://api.offerlayer.io OFFERLAYER_SELLER_KEY=agt_sell_… pnpm mcp
```
