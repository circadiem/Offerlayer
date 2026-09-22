# Offerlayer — mandate rules for agents (v0.2 addendum)

This amends the seller recipe in CONNECTOR.md. Shopper rules do not change.

## Permission model

You do not wait for a tap on every write. You wait once for a **mandate**, then act inside it.

Muse approval cards map like this:

| Muse choice | Offerlayer |
|---|---|
| Allow once | Activate mandate with short `expires_at` (this task), or confirm a single live publish |
| Allow for this task | Activate mandate covering this selling task |
| Allow for this connector / Always allow | Activate mandate; still cannot exceed caps |
| Deny | Do not call `activate_mandate` |

Offerlayer caps are enforced on the server. “Always allow Offerlayer” does not let you publish a $50 reward if the mandate says $5.

Buyer purchases: still show `disclosure` and use Muse’s purchase approval. Do not invent a spend-without-asking path.

## Seller recipe with a mandate

1. Connect the shop (human completes Shopify install). No mandate can skip this.
2. `propose_mandate` with conservative caps. Show the returned `card_text` verbatim on the approval card.
3. Only after the human approves that text: `activate_mandate` with `human_confirmed: true`.
4. Publish / pause / resume / same-policy updates with no further ask.
5. If a write returns `MANDATE_REQUIRED` or `MANDATE_EXCEEDED`, show `error.card_text` and propose an amendment. Do not retry the write until a new mandate is `active`.
6. First live offer on a brand-new shop: still show it once even if a mandate is active.

## What you may do unattended while a mandate is active

- Pause / resume offers that already sit inside the selector and caps
- Publish a new SKU that the mandate selector already allows, at or below caps
- Read performance

## What you must stop and ask for

- First shop bind (OAuth)
- First mandate, and any cap increase
- Selector expansion (new collection / whole shop) if the mandate was narrower
- Anything the API flags `MANDATE_EXCEEDED`

## What you must never do

- Set `human_confirmed: true` because you think the human would agree
- Raise `finder_fee` to steer your other (shopping) conversations
- Promise that a pending_hold reward has paid
