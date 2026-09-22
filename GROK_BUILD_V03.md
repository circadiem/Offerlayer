# Offerlayer v0.3 — Shop Pay / Muse checkout attach

**Read after real-shop bind works. Do not rewrite mandates, roles, tokens, or the hold/clear machine.**

See `attachments/GROK_BUILD_V03.md` for the full spec. Done when `docs/ACCEPTANCE_V03.md` passes.

`POST /v1/checkouts` returns `checkout.permalink` (cart URL + `attributes[agent_ref]` + `payment=shop_pay` + utm) and `checkout.agentic` (variant gid line items, attributes, note, utm). Webhooks accept the token from note attributes, order note, landing-site `utm_content`, or line-item properties.
