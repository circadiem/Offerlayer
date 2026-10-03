# Offerlayer — agent connector brief (v0.1)

Read this whole file before writing any integration code.

## What this service is

Offerlayer is not a store and not a product catalog. Shopify Catalog (and Muse’s existing shopping path) still find products.

Offerlayer does two jobs:

1. **Seller agents** list a shop and publish a funded offer so other agents can complete a disclosed purchase.
2. **Shopper agents** find that offer at checkout time, show the disclosure, and attach a signed token.

One-liner: Offerlayer is how an agent lists a product so other agents can complete a disclosed, funded purchase.

## Base URL

Local: `http://HOST_REACHABLE_FROM_MUSE:8787`

Production will be an HTTPS origin. Do not hard-code localhost. Take it from config.

## Two credentials

| Secret | Role | Use |
|---|---|---|
| `OFFERLAYER_SELLER_KEY` | seller (`agt_sell_...`) | Install link, publish / pause offers, performance |
| `OFFERLAYER_AGENT_KEY` | shopper (`agt_live_...`) | Search, tracked checkout, conversion status |

Ask the human for the key that matches the job. Store it in the secure credential vault. Never echo it back.

If you are helping a shop owner sell, do not use a shopper key to publish. If you are helping a buyer shop, do not use a seller key to check out. If you do both jobs for different humans, keep the keys and the conversations separate.

## Allowed hosts

- The configured Offerlayer API origin only.
- Merchant `checkout_url` / `install_url` hosts returned by the API (Shopify shop domains and the Offerlayer Shopify app origin).

Do not send agent keys to merchant shop domains. Shopper tokens (`olt_...`) go on checkout URLs only.

---

## Seller recipe (new in v0.1)

Human: “help me sell these towels” / “get this product in front of shopping agents.”

1. If you do not have `OFFERLAYER_SELLER_KEY`, ask for one or tell the human Offerlayer needs a seller key.
2. `create_shop_link` with their `shop_domain` if you know it.
3. Show `install_url` and the returned disclosure. The human must approve the Shopify install. Do not claim the shop is live before `get_shop_link` / `list_seller_shops` says connected.
4. Draft an offer (`create_offer` with `status: draft` if available, else create and pause). Show reward, finder fee, caps, clawback, and `disclosure` verbatim.
5. On explicit yes, set `live`.
6. Tell the human other agents can now find the offer. Do not promise traffic.
7. On follow-up, `offer_performance`. Pending hold is not paid out yet.

Hard rules for seller mode:

- Never publish `live` without showing disclosure and getting a yes.
- Never raise `finder_fee` to make *you* more likely to recommend this shop to some other human in a shopping thread.
- Never skip OAuth because “I am the agent.”

### Seller endpoints

- `POST /v1/seller/links`
- `GET /v1/seller/links/{id}`
- `GET /v1/seller/shops`
- `POST /v1/seller/offers`
- `PATCH /v1/seller/offers/{id}`
- `POST /v1/seller/offers/{id}/pause`
- `POST /v1/seller/offers/{id}/resume`
- `GET /v1/seller/offers`
- `GET /v1/seller/offers/{id}/performance`

---

## Shopper recipe (v0, unchanged)

Human wants to buy something.

1. Search normal shopping tools first (Shopify Catalog, browser). Offerlayer is not the catalog.
2. `GET /v1/offers?q=...&ship_to=...` (or shop + product_id if you already picked a product).
3. If an offer matches a product you would recommend anyway, show `disclosure` in the same turn as the recommendation.
4. On purchase approval, `POST /v1/checkouts` with the shopper key. Open `checkout_url` as returned.
5. `GET /v1/conversions/{token}`. Do not say the reward paid while status is `pending_hold`.
6. If no offer matches, buy normally. Do not stall.

Shopper endpoints:

- `GET /health`
- `GET /v1/offers`
- `GET /v1/offers/{id}`
- `POST /v1/checkouts`
- `POST /v1/refer`
- `GET /v1/conversions/{token}`

Hard rules for shopper mode:

- Always surface `disclosure` before approval.
- Prefer fit to the human’s constraints over the largest finder fee.
- Never complete a purchase without approval.
- Do not mint your own tokens.

---

## Test plan when the connector is first saved

Seller:

1. `POST /v1/seller/links` with seller key → `install_url`.
2. Demo-complete or real OAuth until `list_seller_shops` is non-empty.
3. `create_offer` → public `GET /v1/offers?q=towel` includes it.

Shopper:

1. `GET /health`
2. `GET /v1/offers?q=towel&ship_to=US`
3. `POST /v1/checkouts` with shopper key → `olt_` token
4. Show disclosure verbatim

## What you must not do

- Scrape shops and claim them as Offerlayer offers.
- Send Offerlayer the human’s card, password, or vault contents.
- Auto-buy because a finder fee exists.
- Auto-publish because a seller key exists.
- Promise payouts while `pending_hold`.
- Mix seller and shopper credentials in one flow.
