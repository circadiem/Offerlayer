# Acceptance

What must be true before a change ships. CI checks the automated items
on every pull request; the manual items are for releases.

## Automated (CI, `.github/workflows/ci.yml`)

- [ ] `pnpm typecheck`: apps, packages, tests, scripts, and the site
- [ ] `pnpm lint`: no errors
- [ ] `pnpm test`: the full suite on PGlite
- [ ] The same suite on Postgres 16 (`TEST_DATABASE_URL`)
- [ ] `pnpm db:migrate` runs twice without error (migrations are idempotent)
- [ ] The production build boots without `OFFERLAYER_DEMO`, and
      `pnpm check:prod-boot` confirms:
  - [ ] every demo and simulate route returns 404
  - [ ] the playground header does not authenticate
  - [ ] `GET /v1/offers` serves from the database

Notable tests behind these:

| Guarantee | Test |
| --- | --- |
| Demo routes unreachable in production; production seeds no demo data | `apps/api/src/security.test.ts` §2.1 |
| Checkout rate limits, anonymous and outstanding caps, budget, discount cleanup | `security.test.ts` §2.2, §2.7 |
| No raw email stored; email and principal caps line up | `security.test.ts` §2.3 |
| Secret separation and rotation | `security.test.ts` §2.4, `packages/db/src/env.test.ts` |
| Webhook shop check, idempotency, line-item attribution, partial refunds | `security.test.ts` §2.5 |
| Every table has RLS on and no policies | `packages/db/src/env.test.ts` |
| `.env.example` documents every variable and boots demo mode as-is | `packages/db/src/env.test.ts` |
| Public URLs come from configuration, not the Host header | `apps/api/src/origin.test.ts` |
| Offers validate against `protocol/offer.schema.json` | `apps/api/src/api.test.ts` |

## Manual, per release

- [ ] `pnpm demo`, `pnpm demo:seller`, `pnpm demo:mandate`, `pnpm demo:shopify`,
      `pnpm demo:agentic` all finish
- [ ] On a Shopify dev store: install, publish an offer, create a checkout,
      complete the order, and see it attributed (`GET /v1/conversions/{token}`)
- [ ] A partial refund on that order reduces the attributed amount
- [ ] Production env: every variable marked REQUIRED in `.env.example` is set,
      and none uses a demo value (the host refuses to boot otherwise)
- [ ] Public pages carry no internal notes, host names, or keys
