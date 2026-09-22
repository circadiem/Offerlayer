# Offerlayer v0.1 — Seller-agent handoff

**Read this after v0 is green. Extend the existing repo. Do not rewrite checkout, tokens, or the conversion state machine.**

| Field | Value |
|---|---|
| Version | v0.1 |
| Name | Offerlayer (unchanged) |
| Why | Individuals and small shops ask their agents to *sell*. Those agents must be able to put the shop on Offerlayer and publish offers. Shopping agents stay as in v0. |
| Done when | `docs/ACCEPTANCE_V01.md` passes and `pnpm demo:seller` exits 0 |

v0 remains the source of truth for stack, money-as-strings, disclosure rules, HMAC `olt_` tokens, and payout stubs. This file only adds the seller side.

---

## 0. Product rule for this slice

Offerlayer is a tool agents use on behalf of two different humans:

| Role | Principal | Key prefix | Allowed |
|---|---|---|---|
| `shopper` | Buyer | `agt_live_` / existing v0 keys | search, checkout, refer, conversion read |
| `seller` | Shop owner | `agt_sell_` | create install link, CRUD offers for *linked* shops, performance |

A key has exactly one role. Do not issue dual-role keys. If the same Muse helps someone sell and someone else shop, it must use two credentials and must not mix seller pitches into a buyer conversation.

The human still approves Shopify OAuth. The seller agent starts that loop and continues after the shop is linked. There is no “agent-only install” that skips the principal.

---

## 1. Journeys to implement

### Seller agent (new)

1. Human: “help me sell the organic towel set.”
2. Agent calls `create_shop_link` with `shop_domain` (if known) → gets `install_url` + `pending_link_id`.
3. Agent shows the human the URL: “Approve this Shopify install so other agents can take a funded offer on your products.”
4. Human completes OAuth in the existing Shopify app.
5. App hits API `POST /v1/seller/links/complete` (or the app calls the API after auth) and marks the link `connected`. Shop is bound to the seller agent that created the link.
6. Agent polls `GET /v1/seller/shops` until the shop appears.
7. Agent drafts an offer via `POST /v1/seller/offers`, then shows reward, finder fee, caps, and `disclosure` to the human.
8. On yes, status is `live`. Offer appears on public `GET /v1/offers`.
9. Later: `GET /v1/seller/offers/:id/performance`.

If the shop is already connected to this seller agent, skip to step 7.

### Shopper agent (unchanged)

Search → disclose → `create_tracked_checkout` → purchase / simulate → hold → clear.

### Demo (required)

`pnpm demo:seller` must:

1. Create seller agent + shopper agent.
2. Create shop link for `demo-towels.myshopify.com`.
3. Complete the link via a demo endpoint (no live Shopify required).
4. Seller publishes the $4 / 2% towel offer.
5. Shopper searches, checks out, simulates $32 purchase.
6. Print: offer id, token, `pending_hold`, seller performance row (1 attributed order).

---

## 2. Data model additions

```text
agents
  + role        text not null default 'shopper'   -- shopper | seller
  check role in ('shopper','seller')

seller_links
  id (lnk_...)
  seller_agent_id
  shop_domain
  status          pending | connected | expired | revoked
  install_url
  nonce
  expires_at
  merchant_id     nullable until connected
  created_at

shop_grants
  merchant_id
  seller_agent_id
  status          active | revoked
  created_at
  unique (merchant_id, seller_agent_id)
```

v0 `merchants` and `offers` tables stay. Offers already have `merchant_id`. Seller CRUD is authorized through `shop_grants`, not through a global admin key.

A connected shop may grant more than one seller agent (owner + bookkeeper). v0.1: first connecting seller is enough; support multiple grants if cheap.

---

## 3. HTTP API additions

All seller routes require `Authorization: Bearer agt_sell_...`.

A shopper key on a seller route → `403 ROLE_MISMATCH`.
A seller key on `/v1/checkouts` → `403 ROLE_MISMATCH`.

### `POST /v1/seller/links`

```json
{ "shop_domain": "demo-towels.myshopify.com" }
```

`shop_domain` optional if you only need a generic install URL. Response:

```json
{
  "pending_link_id": "lnk_...",
  "install_url": "http://localhost:3000/auth/login?seller_link=lnk_...",
  "expires_at": "...",
  "disclosure": "Your human must approve this Shopify install. You cannot publish offers until they do."
}
```

`install_url` points at the existing Shopify app OAuth start, with `seller_link` in the query. If Shopify credentials are missing, still return a URL of that shape plus `demo_complete_url` for the demo path.

### `GET /v1/seller/links/:id`

Status of the pending link.

### `POST /v1/seller/links/:id/complete`  (demo + app)

Auth: seller bearer **or** `x-demo-key` **or** Shopify app `INTERNAL_API_KEY`.

```json
{ "shop_domain": "demo-towels.myshopify.com" }
```

Creates/uses merchant row, writes `shop_grants`, sets link `connected`.

Shopify app, after successful OAuth, MUST call this with the `seller_link` query param if present so the agent that started the flow is granted.

### `GET /v1/seller/shops`

Shops this seller may manage.

### `POST /v1/seller/offers`

Body: offer fields as in v0 upsert (`selector`, `reward`, `finder_fee`, `constraints`, `disclosure`, `status`).  
`merchant_id` or `shop_domain` required. Must have an active grant.

If `disclosure` omitted, generate from template:

`"{shop_name} funds a {reward} credit on this order if you buy through this Offerlayer offer. Optional agent finder fee: {finder_fee}."`

Never accept `status: live` if disclosure would be under 16 chars.

### `PATCH /v1/seller/offers/:id`

Partial update. Seller must hold a grant on the offer’s shop.

### `POST /v1/seller/offers/:id/pause`

Sets `paused`.

### `POST /v1/seller/offers/:id/resume`

Sets `live` if disclosure and selector still valid.

### `GET /v1/seller/offers`

Query: `shop_domain`, `status`.

### `GET /v1/seller/offers/:id/performance`

```json
{
  "offer_id": "off_...",
  "attributed_orders": 1,
  "pending_hold": { "count": 1, "gmv": "32.00", "reward": "4.00", "finder_fee": "0.64" },
  "cleared": { "count": 0, "gmv": "0.00", "reward": "0.00", "finder_fee": "0.00" },
  "clawed_back": { "count": 0, "gmv": "0.00" }
}
```

### Demo-only

`POST /v1/simulate/connect_shop` with demo key + seller bearer: shortcut that runs link create + complete for `demo-towels.myshopify.com` without a browser. Used by `pnpm demo:seller`.

---

## 4. MCP tools to add

Keep v0 shopper tools unchanged. Add:

| Tool | Maps to | Notes |
|---|---|---|
| `create_shop_link` | `POST /v1/seller/links` | Description must say the human has to open `install_url` |
| `get_shop_link` | `GET /v1/seller/links/:id` | |
| `list_seller_shops` | `GET /v1/seller/shops` | |
| `create_offer` | `POST /v1/seller/offers` | Must echo `disclosure` in the tool result |
| `update_offer` | `PATCH /v1/seller/offers/:id` | |
| `pause_offer` | pause | |
| `resume_offer` | resume | |
| `list_my_offers` | `GET /v1/seller/offers` | |
| `offer_performance` | performance | |

MCP config should accept `OFFERLAYER_SELLER_KEY` separately from `OFFERLAYER_AGENT_KEY` (shopper). If only one key is present, expose only the tools for that role.

Tool descriptions for seller tools start with: “You are helping a shop owner list funded offers. Always show the draft disclosure and wait for the human to approve before setting status live.”

---

## 5. Shopify app change (small)

On OAuth callback, read `seller_link` from the start-auth state (stash it in OAuth state or a short-lived cookie / session). After the shop is stored, `POST /v1/seller/links/:id/complete` with `INTERNAL_API_KEY`.

If no `seller_link`, behavior is v0 (merchant uses the admin UI).

Do not build a new consumer signup site.

---

## 6. Seed / env

`pnpm seed` also creates:

- `agt_seller` with a printed `agt_sell_...` key, role `seller`
- Keep `agt_demo` / `agt_muse` as `shopper`

`.env.example` add nothing required beyond existing keys unless you introduce `OFFERLAYER_SELLER_KEY` for MCP.

---

## 7. Implementation order

1. Migration: `agents.role`, `seller_links`, `shop_grants`.
2. Role checks on existing checkout routes (seller key rejected).
3. Seller link + complete + demo `simulate/connect_shop`.
4. Seller offer CRUD authorized by grants (reuse v0 offer insert).
5. Performance endpoint from existing `orders_ext` / `payouts`.
6. MCP seller tools + split keys.
7. Shopify OAuth state passes `seller_link`.
8. `pnpm demo:seller` + tests in `docs/ACCEPTANCE_V01.md`.
9. Update `protocol/CONNECTOR.md` using the text in this pack (`protocol/CONNECTOR_V01.md` — merge into `CONNECTOR.md`).

---

## 8. Non-goals for v0.1

- Public agent marketplace or directory UI
- Live Stripe / USDC
- Letting a seller key attach checkouts
- Letting a shopper key publish offers
- Auto-going-live without a `status: live` the human (or explicit tool arg after shown disclosure) confirmed
- Multi-shop billing
- Changing token algorithm or payout math

---

## 9. Positioning strings (README + CONNECTOR only)

Use this one-liner in README:

> Offerlayer is how an agent lists a product so other agents can complete a disclosed, funded purchase.

Do not rebrand. Do not rename packages.
