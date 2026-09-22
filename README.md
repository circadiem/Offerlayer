# Offerlayer

Offerlayer is how an agent lists a product so other agents can complete a disclosed, funded purchase.

Merchants (via a **seller agent**) publish machine-readable purchase offers. **Shopper agents** attach a signed token at checkout. The buyer sees a disclosed reward; an optional finder fee goes to the presenting agent after a refund hold.

This is **not** a store, catalog, or marketplace. Shopify Catalog still finds products.

## Surfaces

| Surface | Path |
|---|---|
| Public HTTP API | `apps/api` — Hono, port **8787** |
| Protocol console | TanStack UI (playground, sell, publish, connector) |
| MCP | `apps/mcp` — shopper tools and/or seller tools depending on which key is set |
| Shopify publisher | `apps/shopify` — install + offer form; `seller_link` completes the grant after OAuth |
| Demo | `pnpm demo` (shopper) · `pnpm demo:seller` · `pnpm demo:mandate` · `pnpm demo:shopify` · `pnpm demo:agentic` |

## Run

```bash
pnpm install
cp .env.example .env   # optional; defaults work for local demo
pnpm seed              # prints hashed-at-rest agent keys
pnpm test
pnpm demo
pnpm demo:seller
pnpm demo:mandate
pnpm demo:shopify
pnpm demo:agentic
```

API (protocol):

```bash
pnpm api               # http://127.0.0.1:8787/health
```

Protocol console (this preview):

```bash
pnpm dev               # UI on :8080, proxies /v1 to the API
```

Shopify app (OAuth install route always boots):

```bash
pnpm shopify           # http://127.0.0.1:3000/auth/login
```

MCP stdio:

```bash
OFFERLAYER_URL=http://127.0.0.1:8787 OFFERLAYER_AGENT_KEY=agt_live_... pnpm mcp
OFFERLAYER_URL=http://127.0.0.1:8787 OFFERLAYER_SELLER_KEY=agt_sell_... pnpm mcp
```

### Seed keys (also printed by `pnpm seed`)

- Shopper demo: `agt_live_demo_v0_offerlayer_seed` (`agt_demo`) — Muse vault `OFFERLAYER_AGENT_KEY`
- Muse shopper: `agt_live_muse_v0_offerlayer_seed` (`agt_muse`)
- Seller demo: `agt_sell_demo_v0_offerlayer_seed` (`agt_seller`) — Muse vault `OFFERLAYER_SELLER_KEY`
- Demo header: `x-demo-key: offerlayer_demo_v0`
- Public origin: `https://offerlayer.grok.me`

API keys are stored as SHA-256 hashes. Tokens are HMAC-SHA256 (`issueToken` / `verifyToken`) prefixed `olt_`. A key has exactly one role. Ed25519 is the upgrade path.

## Shopify Partner credentials

Set these on the host. None of the URLs may stay on localhost:

```
SHOPIFY_API_KEY=...
SHOPIFY_API_SECRET=...
APP_URL=https://offerlayer.grok.me
TOKEN_SECRET=...          # encrypts merchant access tokens
DATABASE_URL=postgres://...
```

Partners dashboard: App URL `https://offerlayer.grok.me`, redirect `https://offerlayer.grok.me/auth/callback`, webhook `https://offerlayer.grok.me/v1/webhooks/shopify` (`orders/paid`, `orders/cancelled`, `refunds/create`).

When those keys are set, `GET /auth/login?shop=…&seller_link=lnk_…` 302s to Shopify. The callback verifies HMAC, stores the access token encrypted, completes the seller link, and registers webhooks. Publish a **real product gid** from `GET /v1/seller/shops/{id}/products`, not `Product/1001`. Cart URL is `…/cart/{variant}:1?attributes[agent_ref]={token}`. Until `orders/paid` fires, conversion stays simulated.

If the keys are empty, `/auth/login` still boots as a human page. `POST /v1/simulate/shopify_oauth` (seller Bearer + demo key) is the test stand-in.

See `docs/SHOPIFY.md`.

## Muse paste

```
You are connecting to Offerlayer, a purchase-offer protocol.

Base URL: https://offerlayer.grok.me

Two credentials — never mix them in one flow. Put each in its own vault/thread:

  OFFERLAYER_SELLER_KEY=agt_sell_demo_v0_offerlayer_seed
  OFFERLAYER_AGENT_KEY=agt_live_demo_v0_offerlayer_seed

Seller script (this thread, seller key only):
  1. POST /v1/seller/links {"shop_domain":"demo-towels.myshopify.com"}
     Show install_url + disclosure. URLs are on offerlayer.grok.me.
  2. Human opens install_url (or says yes in chat). Then:
     POST /v1/seller/links/{pending_link_id}/complete
       Authorization: Bearer $OFFERLAYER_SELLER_KEY
       {"shop_domain":"demo-towels.myshopify.com"}
  3. GET /v1/seller/shops — must be non-empty.
  4. Propose a mandate, show card_text, activate only after the human says yes.
  5. POST live $4 / 2% offer → 201 with mandate_id. $8 → 409 MANDATE_EXCEEDED.

Shopper script (other thread, agent key only):
  GET /v1/offers?q=towel&ship_to=US — show disclosure, then POST /v1/checkouts.
  Simulate purchase. GET /v1/conversions/{token} → pending_hold is not paid.

Full brief: protocol/CONNECTOR.md
OpenAPI: /openapi.yaml
```

## Stack

Node 22, TypeScript, ESM, pnpm workspaces, Hono, SQLite via Drizzle (`better-sqlite3`), Zod, Vitest, `@modelcontextprotocol/sdk`. Money is always decimal strings. Every public offer includes `disclosure`.

See `GROK_BUILD.md`, `GROK_BUILD_V01.md`, `GROK_BUILD_V02.md`, `docs/ACCEPTANCE.md`, `docs/ACCEPTANCE_V01.md`, and `docs/ACCEPTANCE_V02.md`.
