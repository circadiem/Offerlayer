# Database

Offerlayer stores everything in Postgres through Drizzle
(`packages/db`). The schema lives in `packages/db/src/schema.ts`; migrations
are generated SQL in `packages/db/migrations/`.

| Where | Database | Driver |
| --- | --- | --- |
| Production (Vercel) | Supabase Postgres | `pg` (node-postgres) |
| Tests | In-memory PGlite (or real Postgres via `TEST_DATABASE_URL`) | PGlite / `pg` |
| Local demo (`OFFERLAYER_DEMO=1`) | PGlite in `./data/pglite`, or `memory:` | PGlite |

A production host refuses to boot unless `DATABASE_URL` is a `postgres://`
URL.

## Supabase setup

1. Create a project. In **Connect**, copy two connection strings:
   - **Transaction pooler** (port 6543): set as `DATABASE_URL` on Vercel. Add
     `?sslmode=require`.
   - **Direct connection** or **session pooler** (port 5432): set as
     `DATABASE_URL_DIRECT`. Only `pnpm db:migrate` uses it.
2. The transaction pooler does not support prepared statements. The app uses
   node-postgres, which only prepares a statement when a query is given a
   `name`; Drizzle only does that for `.prepare()`, which this code base never
   calls. Keep it that way.
3. TLS certificates are always verified. If Node does not trust the
   database's CA, download the CA certificate from the Supabase dashboard
   and set its PEM text as `DATABASE_CA_CERT`.
4. Deploy. `pnpm build` runs `pnpm db:migrate` after the app builds, so every
   deploy migrates before it serves. Preview deployments migrate whatever
   database their `DATABASE_URL` points at, so give previews their own
   database (or no `DATABASE_URL`, which skips migration).

### Row level security

Every table has RLS enabled and **no policies**. The server connects as the
table owner (`postgres`), which bypasses RLS, so the app works normally.
Supabase's `anon` and `authenticated` roles, and the auto-generated REST API
that uses them, can read and write nothing. Never ship the service-role key
or a database URL to a browser.

A test (`packages/db/src/env.test.ts`) fails if a table is added without RLS
or if a policy appears.

## Changing the schema

```
# 1. Edit packages/db/src/schema.ts (add .enableRLS() to any new table)
pnpm db:generate          # writes packages/db/migrations/NNNN_*.sql
# 2. Read the generated SQL. Rename the file's suffix if it helps.
pnpm test                 # PGlite applies the migration on open
TEST_DATABASE_URL=postgres://… pnpm test   # optional: run against real Postgres
```

Commit the schema change, the SQL file, and `migrations/meta/` together.

## Conventions

- Money and percentages are decimal strings (`"32.00"`, `"10"`), never floats.
- Timestamps are ISO-8601 UTC strings. They sort and compare correctly as
  text, and the code compares them that way.
- Counts from raw SQL come back as strings from node-postgres (`bigint`); wrap
  them in `Number(...)` or cast with `::int`.

## Scheduled jobs

Vercel Cron is the one scheduler (see `crons` in `vercel.json`). Jobs are
routes under `/v1/internal/jobs/*` that accept `CRON_SECRET` as a bearer.

## Moving off the old SQLite snapshot

Before this change, the whole SQLite file was stored in one Postgres row
(`offerlayer_store`). That table is not read or dropped by the new code. If
anything in it needs keeping (for example a merchant's Shopify connection),
copy it over by hand before deleting the table. Otherwise drop it once the new
deploy is healthy:

```sql
DROP TABLE IF EXISTS offerlayer_store;
```
