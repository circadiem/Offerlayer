# Muse (Meta)

Muse is Meta's personal AI agent. It is not an Offerlayer partner; it is the
first channel we are building for. Shopify works with Meta so Muse can check
out on Shopify stores with Shop Pay, and Meta offers developer "connectors"
that expose an external API as tools Muse can call.

Nothing in Offerlayer's core code treats Muse differently. This page collects
what is specific to it. The general rules are in `protocol/CONNECTOR.md`.

## Status

| Item | State |
| --- | --- |
| Meta connector developer program | Not applied yet (needs the Partner/legal entity decision) |
| Offerlayer connector built from the API / MCP surface | Not started (Phase 3) |
| Discount + attribution through Muse's Shop Pay checkout | **Unverified.** The checkout-path spike (launch plan §5.5) must answer this before Phase 2 work |

Requirements and format for Meta connectors must be checked against Meta's
current developer docs before building; the program was in developer preview
when this was written.

## Open questions for the checkout spike

1. Can a single-use discount code be applied in Shop Pay checkout started by
   Muse? If so, how does the agent pass it?
2. Do cart attributes (our `agent_ref`) or an equivalent reference reach the
   order, so `orders/paid` can be attributed?
3. How are Muse orders identified on the order (sales channel, source, app)?
   Could attribution use that instead of, or as well as, the token?
4. Can a merchant already restrict a native Shopify discount to an agent or
   Meta sales channel without Offerlayer? If so, what must Offerlayer add?

If 1 or 2 is "no", stop and report: the product depends on them.

## Approval cards

When Muse shows its approval card for an Offerlayer action:

| Muse choice | Offerlayer |
| --- | --- |
| Allow once | Activate a mandate with a short `expires_at`, or confirm a single live publish |
| Allow for this task | Activate a mandate covering this selling task |
| Allow for this connector / Always allow | Activate a mandate; it still cannot exceed its caps |
| Deny | Do not call `activate_mandate` |

On a purchase, the offer's `disclosure` belongs on the same card as the Shop
Pay total, and Muse must get approval every time.

## Keys

Use two separate connector configurations: one with the seller key
(`OFFERLAYER_SELLER_KEY`) and one with the shopper key
(`OFFERLAYER_AGENT_KEY`). Never one connector with both.

## Demo data

Demo mode seeds an agent `agt_muse` ("Muse (demo)") so demos can show
attribution to a named agent. It does not exist in production.
