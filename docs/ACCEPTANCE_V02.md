# Offerlayer v0.2 acceptance

v0 and v0.1 acceptance still pass. Then:

```bash
pnpm seed
pnpm test
pnpm demo:mandate
```

## Mandate lifecycle

- [ ] `POST /v1/seller/mandates` as seller with shop grant → `proposed` + non-empty `card_text`.
- [ ] `POST .../activate` without `human_confirmed: true` → 400 `CONFIRMATION_REQUIRED`.
- [ ] Activate with `human_confirmed: true` → `active`.
- [ ] Second activate for same seller+shop supersedes the first (old `revoked`).
- [ ] Revoke → further live writes `403 MANDATE_REQUIRED`.

## Enforcement

- [ ] Live offer inside caps → 201, `mandate_id` set.
- [ ] Live offer with reward above `max_reward_flat` → 409 `MANDATE_EXCEEDED` and `card_text` present.
- [ ] Finder fee above cap → 409.
- [ ] Offer selector outside mandate selector → 409.
- [ ] No active mandate → live create 403 `MANDATE_REQUIRED`; draft and pause still work.
- [ ] Expired mandate treated as required-new.

## Demo

- [ ] `pnpm demo:mandate` exit 0: activate $5 cap, $4 offer succeeds, $8 offer fails with `MANDATE_EXCEEDED`.

## MCP

- [ ] Tools `propose_mandate`, `activate_mandate`, `list_mandates`, `revoke_mandate`.
- [ ] `activate_mandate` description forbids setting `human_confirmed` without a yes on the exact `card_text`.

## Hygiene

- [ ] CONNECTOR.md includes the v0.2 seller mandate recipe.
- [ ] Shopper checkout still requires disclosure; no new spend-bypass route.
