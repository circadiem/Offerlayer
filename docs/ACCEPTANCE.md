# Offerlayer v0 acceptance

Run from a clean checkout:

```bash
pnpm install
cp .env.example .env
pnpm seed
pnpm test
pnpm demo
```

All of the following must pass.

## Protocol

- [ ] `offer.schema.json` validates the seed towel offer.
- [ ] Every public offer payload includes `disclosure` ≥ 16 characters.
- [ ] Money fields are decimal strings, never numbers.

## API

- [ ] `GET /health` → 200 `{ ok: true }`.
- [ ] `GET /v1/offers?q=towel&ship_to=US` returns the seed offer.
- [ ] `GET /v1/offers?q=lawnmower` returns `[]`, not an error.
- [ ] `POST /v1/checkouts` without bearer → 401.
- [ ] `POST /v1/checkouts` with demo agent key → 201, `token` starts with `olt_`, `checkout_url` contains the token.
- [ ] Second consume of the same token via simulate → 409 or `invalid`.
- [ ] Expired token rejected.
- [ ] Cap: seed `max_per_principal_per_day` enforced on simulate with same `email_hash`.

## Conversion machine

- [ ] simulate purchase → `pending_hold`, `hold_until` ≈ now + clawback_days.
- [ ] `POST /v1/simulate/clear` → `cleared` and two payout rows: buyer $4.00, agent 2% of $32.00 = $0.64.
- [ ] Refund fixture during hold → `clawed_back`, no ready payouts.

## Shopify webhook fixtures

- [ ] `orders/paid` fixture with `note_attributes agent_ref` matches token and creates `pending_hold`.
- [ ] Payload without token is ignored (200, no conversion).
- [ ] HMAC failure → 401.
- [ ] `refunds/create` during hold claws back.

## MCP

- [ ] Tools listed: `search_offers`, `get_offer`, `create_tracked_checkout`, `refer_agent`, `get_conversion`.
- [ ] `search_offers` description mentions showing disclosure to the human.

## Shopify app (manual if partners account missing)

- [ ] App boots and shows OAuth install route.
- [ ] Offer form can create a live offer that appears in `GET /v1/offers?shop=...`.
- [ ] If no Shopify partners app is configured, document the skip in README; API+demo still required green.

## Demo CLI

- [ ] `pnpm demo` prints search results, token, pending_hold, then cleared payout stubs, exit code 0.

## Security hygiene

- [ ] API keys stored hashed.
- [ ] Tokens and keys not written to default logs.
- [ ] `.env` gitignored.
