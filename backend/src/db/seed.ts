/**
 * Idempotent flash-sale seed (Todo 3).
 *
 * - Upserts one sale_config row (id = 1) from env.
 * - Tops up stock_units to exactly STOCK_QTY total rows (available + sold).
 *   Re-runs insert 0 rows; a smaller STOCK_QTY never deletes/shrinks.
 * - JS-compatible TS: only erasable type syntax, runs under
 *   `node backend/src/db/seed.ts` (Node >= 22.6 type stripping).
 *
 * Env:
 *   DATABASE_URL  default postgres://postgres:postgres@localhost:5433/flashsale
 *   SALE_START    default now+60s  (ISO-8601 UTC)
 *   SALE_END      default now+10min (ISO-8601 UTC)
 *   STOCK_QTY     default 100
 *   SALE_PRODUCT  default "Bookipi Flash Widget"
 *
 * Run:
 *   DATABASE_URL=... STOCK_QTY=100 node backend/src/db/seed.ts
 */
import pg from 'pg';

const { Client } = pg;

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5433/flashsale';

const now = Date.now();
const SALE_START = process.env['SALE_START'] ?? new Date(now + 60_000).toISOString();
const SALE_END = process.env['SALE_END'] ?? new Date(now + 10 * 60_000).toISOString();
const STOCK_QTY = Number.parseInt(process.env['STOCK_QTY'] ?? '100', 10);
const SALE_PRODUCT = process.env['SALE_PRODUCT'] ?? 'Bookipi Flash Widget';

if (!Number.isInteger(STOCK_QTY) || STOCK_QTY <= 0) {
  console.error(`[seed] invalid STOCK_QTY=${process.env['STOCK_QTY']}`);
  process.exit(1);
}

const client = new Client({ connectionString: DATABASE_URL });

await client.connect();
try {
  await client.query("SET statement_timeout = '5s'");
  await client.query("SET lock_timeout = '2s'");

  const upsert = await client.query(
    `INSERT INTO sale_config (id, product_name, stock_qty, starts_at, ends_at)
     VALUES (1, $1, $2, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       stock_qty = EXCLUDED.stock_qty,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at
     RETURNING id, product_name, stock_qty, starts_at, ends_at`,
    [SALE_PRODUCT, STOCK_QTY, SALE_START, SALE_END],
  );
  console.log(`[seed] sale_config upserted: ${JSON.stringify(upsert.rows[0])}`);

  // Top up to STOCK_QTY total unit rows without touching existing rows
  // (sold rows are never deleted; a smaller STOCK_QTY inserts 0).
  const topped = await client.query(
    `INSERT INTO stock_units (sale_id, status)
     SELECT 1, 'available'
     FROM generate_series(
       1,
       GREATEST($1 - (SELECT COUNT(*)::int FROM stock_units WHERE sale_id = 1), 0)
     ) AS g
     RETURNING id`,
    [STOCK_QTY],
  );

  const counts = await client.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'available')::int AS available,
       COUNT(*) FILTER (WHERE status = 'sold')::int AS sold
     FROM stock_units WHERE sale_id = 1`,
  );
  console.log(`[seed] stock_units inserted=${topped.rowCount} counts=${JSON.stringify(counts.rows[0])}`);
} finally {
  await client.end();
}
