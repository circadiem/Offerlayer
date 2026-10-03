# Spike: discount and attribution across checkout paths

Launch plan §5.5. Status: **desk research done; live verification pending**
(needs a Shopify dev store with the Partner app, and a way to drive Muse).

Date of research: 2026-10-03. Sources are listed at the end. Shopify's and
Meta's docs move quickly; re-check before relying on any line here.

## Summary

| Question | Answer from docs | Confidence | Live test needed |
| --- | --- | --- | --- |
| 1. Can a single-use code apply in Muse's Shop Pay checkout? | Shopify says discount codes, automatic discounts, and discount Functions are supported in agentic storefront checkouts, Meta included. UCP has a standard `discounts.codes` field the agent submits. | Medium-high that Shopify accepts it; **unknown whether Muse passes a code that a third-party connector supplies** | Yes |
| 2. Does an attribute or reference reach the order? | No evidence that custom cart attributes or notes pass through agentic checkout. **Mitigated in code:** attribution now also matches our single-use code on the order (see below). | Low for attributes; high for the code fallback *if* Q1 holds | Yes |
| 3. How are Muse orders identified? | Agentic storefront orders carry channel attribution in Shopify admin, showing which AI channel (Meta) drove the sale. | Medium | Yes: confirm the exact `source_name` / app id in the webhook payload |
| 4. Can merchants already restrict a native discount to the Meta channel? | No such control found. Channel-scoped discounts exist only indirectly (markets/locations, e.g. POS); GraphQL-created discounts sometimes need channel access granted by hand. Discounts appear to apply uniformly across agentic channels. | Medium | Confirm in a dev store admin |

**Q1 and Q2 are not "no".** Per §5.5, a "no" would stop the plan; the answer
is "yes on Shopify's side, unproven on Muse's side." The deciding test is
whether Muse will take a discount code from a connector tool result and submit
it in checkout.

## What changed in code because of this

Attribution no longer depends on cart attributes surviving checkout. On
`orders/paid`, the webhook first looks for one of our minted `OL…` codes in
`discount_codes` / `discount_applications` and resolves the checkout token from
it; only then does it fall back to `agent_ref`, the order note, or landing-site
parameters. The code is the stronger signal (single-use, minted for one
checkout), so it also wins when an order carries someone else's `agent_ref`.
Tests: `apps/api/src/security.test.ts`, "attribution by single-use discount
code".

Consequence: on any path where our discount was actually applied, the order is
attributable. On a path where the discount is dropped, there is nothing to
attribute and nothing was spent.

## Paths

| Path | Discount code | Our reference | Notes |
| --- | --- | --- | --- |
| Cart permalink (`/cart/{variant}:{qty}?discount=…&attributes[agent_ref]=…`) | Supported (`discount=`; codes containing commas cannot be passed) | `attributes[...]`, `note`, `ref` supported | What `checkout.permalink` builds today. Shop Pay is reachable from it. |
| Shop Pay via permalink | Inherits the cart | Inherits the cart | Verify `payment=shop_pay` keeps the code. |
| Checkout Kit (mobile/web embed) | Expected via the cart it loads | Expected via the cart | Not researched in depth; verify. |
| UCP / Shopify agentic checkout (Muse, Google, Copilot) | `discounts.codes` in checkout create/update; codes replace prior codes, case-insensitive | Not found in public schema summaries | Our code fallback covers attribution. |
| ChatGPT flow | Shopper pays on the merchant's store, so normal discounts apply | As permalink | Per third-party summary; verify. |

## Strategic check (§5.5 Q4): what Offerlayer adds

Shopify already gives every agent channel the merchant's normal discounts, and
merchants cannot (as far as the docs show) make a discount apply *only* to
agent orders. That leaves Offerlayer's value as:

1. **Agent-only pricing without a public code**: single-use, cart-bound,
   short-lived codes minted per checkout, instead of a reusable code that leaks.
2. **Cross-agent reach and discovery**: one offer, findable by any agent via
   API/MCP and storefront discovery, rather than per-channel setup.
3. **Budgets and limits**: daily/monthly caps, per-shopper limits, enforced at
   mint time.
4. **Reporting by agent**: attributed orders and discount cost per agent and
   offer, net of refunds.
5. **Disclosure**: a standard, machine-readable disclosure agents must show.

**Flag for Maximilian:** if Shopify adds channel-scoped discounts for agentic
storefronts, (1) weakens for single-channel merchants. Points 2–5 remain.

## Live test plan

On a dev store with the app installed and one live offer:

1. `POST /v1/checkouts`; open `checkout.permalink` in a browser; pay with a
   test card. Expect: code applied, `orders/paid` attributed, line-item
   attribution correct.
2. Same with Shop Pay selected.
3. Through Muse (once a connector or test harness is available): have Muse
   find the product, call `create_checkout`, and complete with Shop Pay.
   Record: did the code apply? What arrived on the order (`source_name`,
   `app_id`, attributes, note, `discount_codes`)? Was it attributed?
4. Partial refund on one of the orders; expect a proportional reduction.
5. In the dev store admin, look for any way to scope a discount to the Meta
   channel.

## Sources

- Shopify cart permalinks: https://shopify.dev/docs/apps/build/checkout/create-cart-permalinks
- Shopify Help Center, agentic storefronts (Meta): https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/meta
- Shopify Help Center, agentic storefront requirements: https://help.shopify.com/en/manual/online-sales-channels/agentic-storefronts/requirements
- Shopify engineering, building UCP: https://shopify.engineering/ucp
- Google Merchant, UCP promo codes: https://developers.google.com/merchant/ucp/guides/checkout/promo-codes
- UCP Discounts extension: http://ucp.dev/2026-04-08/specification/discount/
- Channel-restricted discounts (Shopify dev community): https://community.shopify.dev/t/restricting-discounts-to-specific-sales-channels-e-g-pos-only/36785
- Shopify × Meta Muse coverage: https://www.pymnts.com/commerce/ecommerce/2026/shopify-brings-shop-pay-checkout-solution-to-metas-muse-ai-agent/ and https://www.contentgrip.com/shopify-muse-shop-pay/
