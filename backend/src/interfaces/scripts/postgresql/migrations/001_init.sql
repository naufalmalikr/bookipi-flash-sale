-- Flash-sale schema (Todo 3).
-- Run: psql "$DATABASE_URL" -f backend/src/db/schema.sql
-- Idempotent: safe to re-run (CREATE TABLE / INDEX IF NOT EXISTS).

SET statement_timeout = '5s';
SET lock_timeout = '2s';

CREATE TABLE IF NOT EXISTS sale_config (
  id            INTEGER PRIMARY KEY,
  product_name  TEXT NOT NULL,
  stock_qty     INTEGER NOT NULL CHECK (stock_qty > 0),
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS stock_units (
  id        SERIAL PRIMARY KEY,
  sale_id   INTEGER NOT NULL REFERENCES sale_config (id),
  status    TEXT NOT NULL CHECK (status IN ('available', 'sold')),
  sold_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS purchases (
  id                SERIAL PRIMARY KEY,
  sale_id           INTEGER NOT NULL REFERENCES sale_config (id),
  canonical_user_id TEXT NOT NULL,
  unit_id           INTEGER NOT NULL UNIQUE REFERENCES stock_units (id),
  raw_user_id       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sale_id, canonical_user_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_units_sale_status
  ON stock_units (sale_id, status);
