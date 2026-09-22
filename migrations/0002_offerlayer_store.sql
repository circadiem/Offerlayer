-- Durable snapshot of the Offerlayer SQLite protocol store (Vercel / Neon).
create table if not exists offerlayer_store (
  id text primary key,
  sqlite_bytes bytea not null,
  updated_at timestamptz not null default now()
);
