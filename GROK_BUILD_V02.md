# Offerlayer v0.2 — Standing mandates

**Read after v0.1 is green. Extend the existing repo. Do not rewrite checkout, tokens, roles, or the conversion machine.**

| Field | Value |
|---|---|
| Version | v0.2 |
| Name | Offerlayer |
| Why | Seller agents should run unattended inside a human-approved box. Permission happens once (mandate). Writes outside the box stop and ask again. |
| Done when | `docs/ACCEPTANCE_V02.md` passes and `pnpm demo:mandate` exits 0 |

v0 / v0.1 remain source of truth for stack, roles (`shopper` / `seller`), Shopify bind, `olt_` tokens, and payout stubs.

---

## 0. Rule

Autonomy is replay of a mandate. It is not “the agent is logged in.”

| Gate | Frequency | Unlocks |
|---|---|---|
| Shopify OAuth | Once per shop | Bind shop to seller agent |
| Mandate | Once per policy (until expiry / revoke / exceed) | Publish / pause / resume / update offers **within limits** |
| Muse purchase card | Every buyer checkout (do not try to bypass) | Spend the buyer’s money |

A seller key with **no active mandate** may: create install links, list shops, list offers, read performance. It may **not** set an offer `live` or raise live commercial terms.

`human_confirmed: true` on a tool call is accepted in v0.2 as the stand-in for a Muse Sentinel card (`Allow once` / `Allow for this task` / `Allow for this connector`). Do not invent a fake Muse SDK. Document the mapping in CONNECTOR.md.

---

## 1. Mandate document

```json
{
  "id": "man_...",
  "seller_agent_id": "agt_...",
  "merchant_id": "...",
  "shop_domain": "demo-towels.myshopify.com",
  "status": "proposed | active | exceeded | expired | revoked",
  "expires_at": "2026-12-31T00:00:00Z",
  "allow": {
    "publish": true,
    "pause": true,
    "resume": true,
    "update_within_caps": true
  },
  "caps": {
    "max_reward_flat": "5.00",
    "max_reward_percent": "15",
    "max_finder_fee_flat": "2.00",
    "max_finder_fee_percent": "3",
    "max_daily_liability": "200.00",
    "max_clawback_days": 14
  },
  "selector": {
    "type": "product | collection | shop",
    "ids": ["gid://shopify/Product/123"]
  },
  "card_text": "plain language shown to the human",
  "human_confirmed_at": null,
  "revoked_at": null
}
```

`card_text` is generated server-side from caps + shop + expiry. Clients must show that string, not a paraphrase, when asking the human.

Liability for the day = sum of `reward` (computed) on attributed orders that day for offers under this mandate, plus live offers’ worst-case remaining cap if easy; v0.2 minimum: sum of pending_hold + cleared reward amounts created today for this merchant by this seller. If that plus the new offer’s worst-case one-order reward would exceed `max_daily_liability`, reject with `MANDATE_EXCEEDED`.

---

## 2. Journeys

### First-time seller (human in the loop)

1. v0.1: install link → human OAuth → grant.
2. `POST /v1/seller/mandates` with proposed caps → status `proposed`, returns `card_text`.
3. Agent shows `card_text` in chat / Muse approval card.
4. `POST /v1/seller/mandates/:id/activate` with `{ "human_confirmed": true }`.
5. Status `active`. Subsequent matching writes do not need confirmation.

### Unattended (the point)

6. Inventory change / new SKU in selector → `create_offer` / `resume_offer` within caps → 201, no `human_confirmed`.
7. Pause sold-out SKU → 200, no confirmation.
8. Performance reads → always allowed.

### Exceed (ask again)

9. Agent wants $8 reward while cap is $5 → API `409 MANDATE_EXCEEDED` with `{ "required": "new_mandate_or_amendment", "card_text": "..." }`.
10. Agent proposes amendment (`POST /v1/seller/mandates` replacing caps) → human confirms → activate → retry write.

### Buyer (unchanged)

Tracked checkout still requires shopper key + disclosure. Do not add a spend mandate that skips Muse’s purchase card.

---

## 3. Data model

```text
mandates
  id (man_...)
  seller_agent_id
  merchant_id
  status
  expires_at
  allow_json
  caps_json
  selector_json
  card_text
  human_confirmed_at
  revoked_at
  superseded_by     nullable mandate id
  created_at
  updated_at

offers
  + mandate_id      nullable  -- set when published under a mandate
```

Only one `active` mandate per `(seller_agent_id, merchant_id)` at a time. Activating a new one sets the previous to `revoked` and `superseded_by`.

---

## 4. HTTP API

All mandate routes: seller bearer + grant on that shop.

### `POST /v1/seller/mandates`

Body: `shop_domain` or `merchant_id`, `caps`, `selector`, `expires_at` (default +90 days, max +365).  
Creates `proposed`. Fills `card_text`.

### `GET /v1/seller/mandates` and `GET /v1/seller/mandates/:id`

### `POST /v1/seller/mandates/:id/activate`

```json
{ "human_confirmed": true }
```

Without `human_confirmed: true` → `400 CONFIRMATION_REQUIRED`.  
`proposed` → `active`. Expiry in the past → `410`.

### `POST /v1/seller/mandates/:id/revoke`

Seller or demo key. Active → `revoked`. Live offers stay live but further updates that need a mandate fail until a new one is active. v0.2 does **not** auto-pause all offers on revoke (document this). Optional query `pause_offers=true` to pause them.

### Enforcement on existing seller writes

`POST /v1/seller/offers` with `status: live`, `resume`, and any PATCH that changes reward / finder_fee / selector / live status:

1. Load active mandate for this seller + shop.
2. No mandate → `403 MANDATE_REQUIRED`.
3. Expired → set `expired`, `403 MANDATE_REQUIRED`.
4. Offer selector outside mandate selector (product not in allowed ids; collection mismatch; mandate is product-scoped and offer is shop-wide) → `409 MANDATE_EXCEEDED`.
5. Reward / finder_fee above caps → `409 MANDATE_EXCEEDED`.
6. Daily liability would exceed → `409 MANDATE_EXCEEDED`.
7. Else allow. Store `mandate_id` on the offer.

Draft / pause / list / performance: no mandate required.

Shopper routes unchanged.

Error body:

```json
{
  "error": {
    "code": "MANDATE_EXCEEDED",
    "message": "Reward $8.00 exceeds mandate cap $5.00",
    "card_text": "Allow Offerlayer to raise the buyer reward cap to $8.00 on demo-towels through 2026-12-31?"
  }
}
```

---

## 5. MCP tools

Add:

| Tool | Maps to |
|---|---|
| `propose_mandate` | `POST /v1/seller/mandates` |
| `activate_mandate` | activate — description **requires** showing `card_text` and only calling after the human said yes |
| `list_mandates` | GET list |
| `revoke_mandate` | revoke |

Update `create_offer` / `update_offer` / `resume_offer` descriptions: if the API returns `MANDATE_REQUIRED` or `MANDATE_EXCEEDED`, show `card_text` and call `propose_mandate` + `activate_mandate` before retrying. Do not retry in a loop.

`activate_mandate` parameters must include `human_confirmed` (boolean). The tool description says: “Set human_confirmed true only after the human approved the exact card_text in this turn.”

---

## 6. Demo

`pnpm demo:mandate`:

1. Reuse demo shop connect from v0.1 (or call simulate/connect_shop).
2. Propose mandate: reward cap $5 / 15%, finder fee 3%, product = seed towel, 90 days.
3. Activate with `human_confirmed: true`.
4. Create live $4 / 2% offer → 201.
5. Attempt live $8 reward → 409 `MANDATE_EXCEEDED`.
6. Print both outcomes. Exit 0.

Also add a unit test: activate without `human_confirmed` fails.

---

## 7. CONNECTOR

Merge `protocol/CONNECTOR_V02.md` into `protocol/CONNECTOR.md`.

Seller recipe becomes:

1. Connect shop (OAuth) once.
2. `propose_mandate` → show `card_text` as a Muse approval (prefer Allow for this connector / this task).
3. `activate_mandate` only after yes.
4. Work inside the box with no further pings.
5. On `MANDATE_EXCEEDED`, show the new `card_text`; do not write anyway.
6. Never treat connector “Always allow” as permission to exceed Offerlayer caps.
7. Buyer checkouts still need disclosure + Muse purchase approval every time.

---

## 8. Implementation order

1. `mandates` table + `offers.mandate_id`.
2. Propose / get / activate / revoke.
3. Enforce on live writes + tests.
4. MCP tools + description text.
5. `pnpm demo:mandate`.
6. Merge CONNECTOR_V02.

---

## 9. Non-goals

- Real Muse Sentinel SDK / AP2 credentials
- Skipping Shopify OAuth
- Spend mandates that bypass purchase approval
- Auto-pause every offer on revoke (unless `pause_offers=true`)
- Mandate marketplace UI
- Renaming Offerlayer
