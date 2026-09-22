# Offerlayer — Grok Build Handoff

**Read this file first. Build only what this file says. Do not invent a marketplace UI, crypto rails, or a Muse-only product.**

| Field | Value |
|---|---|
| Working name | Offerlayer |
| One-liner | Merchants publish machine-readable purchase offers. Agents (Muse first) attach a signed token at checkout. Buyer gets a disclosed reward; optional finder fee goes to the presenting agent after a refund hold. |
| Primary surfaces | Shopify app (publisher) + public HTTP API / OpenAPI / MCP (consumer) + Muse connector brief |
| Non-goal | Replacing Shopify Catalog, Shop Pay, or Muse product discovery |
| Date | 2026-09-19 |
| Status | v0 spec — implement MVP in this repo |

Companion files in this folder:

- `protocol/offer.schema.json` — canonical offer document
- `protocol/openapi.yaml` — public API
- `protocol/CONNECTOR.md` — brief Muse (or any agent) uses to integrate
- `docs/ACCEPTANCE.md` — pass/fail tests for v0

---

## 0. How to work

1. Implement in a single repo with the layout in §3.
2. Get the **API + SQLite + token flow + simulated checkout** green before the Shopify app.
3. Then the Shopify app as a publisher of the same offer documents.
4. Then MCP wrapping the same API.
5. Stop at v0. Do not start Stripe live payouts, USDC, agent reputation, or a public directory UI unless v0 acceptance passes.

Default stack (do not change without a reason in the README):

- Node 22, TypeScript, ESM
- Hono API
- SQLite via Drizzle (local) with a Postgres-ready schema
- Zod for runtime validation matching `offer.schema.json`
- `@modelcontextprotocol/sdk` for MCP
- Shopify app: official Remix + `@shopify/shopify-app-remix` template
- Auth: merchant session (Shopify) + agent API keys + Ed25519 offer tokens
- Tests: Vitest + a `scripts/demo.ts` happy path

---

## 1. Product rules (do not violate)

1. The customer is the human (principal). The agent is a channel with a key.
2. Buyer reward is visible before purchase. Finder fee is optional and also disclosed.
3. Pay only on qualified, paid, non-clawed-back orders — never on click or “I recommended it.”
4. Same protocol works for Muse, Claude, OpenClaw, curl. Muse is customer zero, not a lock-in.
5. Do not steer silently toward the highest bounty. `search_offers` returns offers; ranking may include `reward.amount` but must also return `disclosure`.
6. Tokens bind `offer_id + agent_id + principal_hash + exp + nonce`. Replay is rejected.
7. Caps and clawbacks are enforced server-side, not trusted from the agent.

### v0 recipients

| Field | Who | v0 behavior |
|---|---|---|
| `reward` | Buyer / principal | Recorded as pending credit on attributed paid order. Payout adapter may be a stub that writes `payouts` rows. |
| `finder_fee` | Presenting agent | Same, separate row. Default 0 if omitted. |

### v0 non-goals

- Live Stripe Connect / PayPal mass-pay
- x402 / USDC
- Multi-touch attribution beyond last presenting agent + optional one-hop `refer`
- Fraud ML
- Merchant billing for the app (free while testing)
- A consumer website
- Building a Muse official-directory submission form (write `CONNECTOR.md` only)

---

## 2. User journeys to implement

### Merchant (Shopify)

1. Install app.
2. Pick a product or collection.
3. Set reward (`flat` $ or `percent`), optional finder fee, `new_customer_only`, ship-to countries, max units per principal per day, clawback days (default 14).
4. App upserts an Offer and serves it at `GET /v1/offers` and `GET /.well-known/agent-offers.json` for that shop.
5. On `orders/paid`, if the order cart URL or note/metafield contains a valid token, mark conversion `pending_hold`.
6. After clawback window with no refund, mark `cleared` and insert payout rows.
7. On refund/cancel during hold, mark `clawed_back`.

### Agent (Muse or demo client)

1. `GET /v1/offers?q=towels&ship_to=US&max_price=40`
2. Pick an offer. Show `disclosure` to the human.
3. `POST /v1/checkouts` with `offer_id`, `agent_id`, optional `principal_ref` → `{ token, checkout_url }`.
4. Human approves. Checkout happens on Shopify (or simulator in API-only mode).
5. `GET /v1/conversions/:token` shows status.

### Simulated checkout (required for API-only demo)

`POST /v1/simulate/purchase` exists so the protocol can be tested without Shopify:

```json
{ "token": "olt_...", "order_total": "32.00", "currency": "USD", "email_hash": "..." }
```

This mints a fake order and runs the same conversion state machine.

---

## 3. Repo layout

```text
/
  README.md
  package.json                  # workspace root
  GROK_BUILD.md                 # copy of this file
  protocol/
    offer.schema.json
    openapi.yaml
    CONNECTOR.md
  packages/
    schema/                     # zod schemas generated/kept in sync with JSON Schema
    token/                      # issue + verify Ed25519 offer tokens
    db/                         # drizzle schema + migrations
  apps/
    api/                        # Hono server (public API + well-known + webhooks)
    mcp/                        # MCP stdio + streamable HTTP wrapping API
    shopify/                    # Remix Shopify app
    demo-agent/                 # tiny CLI: search → claim → simulate purchase
  docs/
    ACCEPTANCE.md
```

Monorepo: `pnpm` workspaces.

---

## 4. Data model

```text
merchants
  id, shop_domain, shopify_shop_id, access_token_enc, created_at

offers
  id (off_...), merchant_id, status (draft|live|paused)
  selector_type (product|collection|shop)
  selector_ids_json
  reward_type (flat|percent), reward_amount, reward_currency, reward_recipient (buyer)
  finder_fee_type, finder_fee_amount, finder_fee_recipient (agent)
  new_customer_only, ship_to_json, max_per_principal_per_day, max_units_per_order
  clawback_days, disclosure, checkout_url_template
  created_at, updated_at

agents
  id (agt_...), name, public_key, api_key_hash, status

principals
  id, merchant_id, email_hash, shopify_customer_id?, first_seen_at

tokens
  token_id, offer_id, agent_id, principal_hash, referrer_agent_id?
  exp, nonce, raw_jws, consumed_at, created_at

orders_ext
  id, merchant_id, shopify_order_id?, token_id, total, currency
  email_hash, status (pending_hold|cleared|clawed_back|invalid)
  paid_at, hold_until, clawed_at

payouts
  id, order_ext_id, party (buyer|agent), agent_id?, amount, currency
  status (pending|ready|stubbed|failed)
```

Indexes: `tokens.nonce` unique, `offers(merchant_id,status)`, `orders_ext(shopify_order_id)` unique where not null.

---

## 5. Token format

Use compact JWS (or a signed payload with the same fields) and prefix `olt_`.

Payload:

```json
{
  "iss": "offerlayer",
  "off": "off_towel_organic_set",
  "agt": "agt_muse_demo",
  "prn": "sha256:email-or-muse-user-ref",
  "ref": null,
  "nce": "22-char-nonce",
  "exp": 1760000000,
  "aud": "checkout"
}
```

Rules:

- TTL default 60 minutes.
- One successful conversion per token.
- `prn` may be `"anon"` only if merchant allows it (v0: allow, but caps still apply on IP hash if no email).
- Verification uses server private key to issue, server public key to verify (symmetric HMAC is acceptable for v0 if Ed25519 adds time — prefer HMAC-SHA256 `olt_` tokens signed with `TOKEN_SECRET` for v0 speed, document the upgrade path).

**v0 decision: HMAC-SHA256 tokens with `TOKEN_SECRET`. Interface them behind `issueToken` / `verifyToken` so the algorithm can change.**

---

## 6. HTTP API (implement exactly)

Base: `/v1`. JSON. CORS open for v0. Auth:

- Public: `GET /health`, `GET /.well-known/agent-offers.json`, `GET /v1/offers`, `GET /v1/offers/:id`
- Agent: `Authorization: Bearer agt_live_...` for claim/checkout/refer/status
- Merchant webhook: Shopify HMAC
- Admin/demo: `x-demo-key`

### Endpoints

`GET /health` → `{ "ok": true, "version": "0.1.0" }`

`GET /.well-known/agent-offers.json`  
Shop-scoped via `?shop=example.myshopify.com` or `Host`. Returns `{ "protocol": "offerlayer/0.1", "offers": [ ... ] }`.

`GET /v1/offers`  
Query: `q`, `ship_to`, `max_price`, `shop`, `product_id`, `limit` (default 20, max 50).  
Response: `{ "offers": Offer[] }`.

`GET /v1/offers/:id`

`POST /v1/checkouts`  
Body:

```json
{
  "offer_id": "off_...",
  "principal_ref": "optional opaque id or email",
  "return_url": "optional"
}
```

Agent id from bearer token.  
Response:

```json
{
  "token": "olt_...",
  "expires_at": "...",
  "checkout_url": "https://example.myshopify.com/cart/123:1?agent_ref=olt_...",
  "disclosure": "...",
  "reward": {},
  "finder_fee": {}
}
```

`POST /v1/refer`  
Body: `{ "offer_id", "to_agent_id"? }`  
Returns a token with `ref` = caller. v0: one hop only.

`GET /v1/conversions/:token`

`POST /v1/simulate/purchase`  
Demo/agent key required. Runs conversion machine.

`POST /v1/webhooks/shopify`  
Handles `orders/paid`, `orders/cancelled`, `refunds/create`. Verifies HMAC.

`POST /v1/internal/offers`  
Demo or Shopify app session. Upsert offer (used by Shopify app and seed script).

Errors: `{ "error": { "code": "OFFER_NOT_LIVE", "message": "..." } }` with 4xx/5xx.

---

## 7. Shopify app (v0)

Use the official Remix app template.

### App surfaces

- After auth: home list of live offers + “New offer.”
- New offer form: product picker (ResourcePicker), reward type/amount, finder fee, clawback days, new-customer toggle, ship-to (US default), max per principal per day.
- Save → POST to API upsert (app and API share DB, or Shopify app calls API with `SHOP_INTERNAL_KEY`).
- Settings: clawback default, disclosure template.

### Checkout attribution

On `create_tracked_checkout`, `checkout_url` must include the token in a durable place Shopify will persist:

1. Preferred: cart permalink with `attributes[agent_ref]=olt_...` if supported.
2. Also set note attribute via Storefront/Ajax if the demo uses a theme.
3. Webhook handler reads `note_attributes` / `cart_attributes` / `metafields` for `agent_ref`.
4. Additionally accept `?agent_ref=` on landing; theme app extension **not required for v0** if simulate + note_attribute path works.

For v0 it is acceptable that the reliable path is:

- Demo agent uses `simulate/purchase`, and
- Shopify webhook path is implemented and tested with a fixture payload that includes `"note_attributes": [{ "name": "agent_ref", "value": "olt_..." }]`.

A theme app extension that writes the cart attribute from the query string is a plus, not a blocker.

### Webhooks to register

- `ORDERS_PAID`
- `ORDERS_CANCELLED`
- `REFUNDS_CREATE`

### Scopes

`read_products`, `write_products` (only if needed), `read_orders`, `write_orders` (if stamping metafields), `read_customers`.  
Stamp order metafield `offerlayer.agent_ref` when you can; otherwise note attributes are enough.

---

## 8. MCP server

Tools (names stable):

| Tool | Maps to |
|---|---|
| `search_offers` | `GET /v1/offers` |
| `get_offer` | `GET /v1/offers/:id` |
| `create_tracked_checkout` | `POST /v1/checkouts` |
| `refer_agent` | `POST /v1/refer` |
| `get_conversion` | `GET /v1/conversions/:token` |

Include tool descriptions that tell the model to **always surface `disclosure` to the human before checkout**.

Transport: stdio for local, streamable HTTP on `/mcp` of the API process or standalone `apps/mcp`.

---

## 9. Seed + demo

`pnpm seed` creates:

- Merchant `demo-towels.myshopify.com`
- Product selector “Organic Turkish Towel Set” price 32.00 USD
- Offer: `$4.00` buyer reward, `2%` finder fee, clawback 14, ship US, disclosure string set
- Agent `agt_demo` with printed API key
- Agent `agt_muse` with printed API key

`pnpm demo` runs:

1. Search `q=towel&ship_to=US`
2. Create checkout
3. Simulate purchase $32
4. Print conversion `pending_hold`
5. Fast-forward hold (`POST /v1/simulate/clear` allowed in demo) → `cleared` + two payout stubs ($4 buyer, $0.64 agent)

---

## 10. Env

```text
PORT=8787
DATABASE_URL=file:./dev.db
TOKEN_SECRET=                    # 32+ bytes
DEMO_KEY=
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=
SHOPIFY_SCOPES=read_products,read_orders,write_orders
INTERNAL_API_KEY=                # Shopify app → API
```

Never commit secrets. `.env.example` only.

---

## 11. Implementation order for the coding agent

Do these PRs / commits in order. Do not skip ahead to Shopify UI.

1. Workspace + `packages/schema` + `packages/token` + unit tests.
2. `packages/db` + migrations + seed.
3. `apps/api` read endpoints + well-known.
4. `apps/api` checkout + token consume + simulate purchase + state machine.
5. `apps/demo-agent` CLI + `pnpm demo` green.
6. `apps/mcp`.
7. `apps/shopify` install + offer form + upsert.
8. Shopify webhook handler + fixture tests.
9. README with run instructions and Muse paste snippet from `CONNECTOR.md`.

---

## 12. Coding standards

- No `any`. Zod at every boundary.
- Money as decimal strings `"4.00"`, never float.
- IDs: `off_`, `agt_`, `olt_`, `ord_`, `pay_` prefixes, ulid or nanoid.
- Logs: structured JSON, never log raw tokens or API keys.
- All public offer responses include `disclosure`.
- Time UTC ISO-8601.

---

## 13. What “done” means

v0 is done when every item in `docs/ACCEPTANCE.md` passes on a clean `pnpm install && pnpm seed && pnpm demo && pnpm test`.

Ship artifacts:

- Running API on localhost:8787
- Printed demo keys
- This protocol folder unchanged in spirit (you may tighten schemas; do not remove fields)
- README a third party can follow to paste `CONNECTOR.md` into Muse
