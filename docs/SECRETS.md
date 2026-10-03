# Secrets and rotation

A production host (no `OFFERLAYER_DEMO=1`) refuses to boot unless every secret
below is set, long enough, different from every other secret, and not one of
the public demo values. Generate each with `openssl rand -hex 32`.

| Variable | Used for | Min length |
| --- | --- | --- |
| `TOKEN_SIGNING_SECRET` | Signs checkout tokens (`olt_…`) | 32 |
| `ACCESS_TOKEN_ENCRYPTION_KEY` | Encrypts merchant Shopify access tokens at rest (AES-256-GCM) | 32 |
| `PRINCIPAL_HASH_SECRET` | HMAC for shopper identifiers: `principal_ref` and order emails | 32 |
| `INTERNAL_API_KEY` | Operator access to `/v1/internal/*`, including the cleanup job | 16 |
| `DEMO_AGENT_KEY`, `MUSE_AGENT_KEY`, `SELLER_AGENT_KEY` | Seeded agent API keys (until self-serve keys ship) | 16 |
| `SHOPIFY_API_SECRET` | Shopify OAuth and webhook HMAC (required when `SHOPIFY_API_KEY` is set) | — |
| `CRON_SECRET` (optional) | Bearer that Vercel Cron sends to the cleanup job | 16 |

`TOKEN_SECRET` is no longer read. A host that still sets only that refuses to
boot and says so.

## Rotating

### `TOKEN_SIGNING_SECRET`

1. Set `TOKEN_SIGNING_SECRET_PREVIOUS` to the current value and
   `TOKEN_SIGNING_SECRET` to a new one. Deploy.
2. New tokens are signed with the new secret. Tokens signed with the old one
   still verify, so orders paid on in-flight checkouts still attribute.
3. After a few days (Shopify can deliver `orders/paid` late), remove
   `TOKEN_SIGNING_SECRET_PREVIOUS`. Deploy.

### `ACCESS_TOKEN_ENCRYPTION_KEY`

1. Set `ACCESS_TOKEN_ENCRYPTION_KEY_PREVIOUS` to the current value and
   `ACCESS_TOKEN_ENCRYPTION_KEY` to a new one. Deploy. Stored tokens still
   decrypt with the previous key; tokens from new installs use the new key.
2. Stored tokens are not re-encrypted automatically yet. Keep the previous key
   set until every merchant has reinstalled or a re-encryption job has run.
   Removing it early disconnects those shops.

### `PRINCIPAL_HASH_SECRET`

There is no previous-key fallback. After a change, hashes of the same shopper
no longer match older rows, so per-shopper daily caps start over. Rotate only
if the secret leaks, and expect that one-day reset.

### Agent keys, `INTERNAL_API_KEY`, `CRON_SECRET`

Change the value and deploy. Callers using the old value get 401 right away.
Hand the new value to whoever needs it, through the host's secret store,
never through a doc or chat.

### `SHOPIFY_API_SECRET`

Rotate in the Shopify Partner dashboard first, then update the host. Webhooks
signed with the old secret fail HMAC and are retried by Shopify, so deploy
promptly.

## Cutover from `TOKEN_SECRET`

Before this change, one `TOKEN_SECRET` both signed tokens and encrypted
access tokens. To move without disconnecting any shop:

```
TOKEN_SIGNING_SECRET=<new>
TOKEN_SIGNING_SECRET_PREVIOUS=<old TOKEN_SECRET>
ACCESS_TOKEN_ENCRYPTION_KEY=<new>
ACCESS_TOKEN_ENCRYPTION_KEY_PREVIOUS=<old TOKEN_SECRET>
PRINCIPAL_HASH_SECRET=<new>
```

Then remove `TOKEN_SECRET`. The `*_PREVIOUS` values are not checked for
length or uniqueness, so an old 16-character `TOKEN_SECRET` still works there.
