import { Client as PgClient } from 'pg';
import type { Application } from '../../../Application.ts';
import { PostgresDatabase } from '../../../repositories/database/postgresql/index.ts';
import { InMemoryCache } from '../../../repositories/cache/in-memory/index.ts';
import { ConsoleLogger } from '../../../repositories/logger/console/index.ts';
import { SaleServiceImpl } from '../../../services/sale/index.ts';
import { PurchaseServiceImpl } from '../../../services/purchase/index.ts';
import { loadConfig } from '../../../Config.ts';

export const CONNECTION_STRING: string = loadConfig().databaseUrl;

export interface StatusBody {
  status: string;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

export interface PurchaseOk {
  result: string;
  unitId: number;
}

export interface ErrBody {
  error: string;
  message: string;
}

export function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function buildTestApplication(rateLimitBuy = 0): { application: Application; client: PgClient } {
  const client = new PgClient({ connectionString: CONNECTION_STRING });
  const config = {
    port: 0,
    databaseUrl: CONNECTION_STRING,
    saleStart: isoAt(60_000),
    saleEnd: isoAt(600_000),
    stockQty: 5,
    saleProduct: 'Flash Widget',
    rateLimitBuy,
    poolMax: 10,
    trustProxy: false,
  };
  const database = new PostgresDatabase(config);
  const cache = new InMemoryCache();
  const logger = new ConsoleLogger();
  const application: Application = {
    config,
    saleService: new SaleServiceImpl(database, cache, logger),
    purchaseService: new PurchaseServiceImpl(database, cache, logger),
    database,
    cache,
    logger,
  };
  return { application, client };
}

/**
 * Reseed guard: resetDb wipes purchases + stock_units, so it refuses any
 * database outside the explicit allowlist. A reviewer pointing
 * DATABASE_URL at the proof volume (or prod) gets a hard failure instead
 * of a silent wipe — same-db-name volumes are still protected because the
 * harness only runs with INTEGRATION_RESEED=1, which CI and the documented
 * `npm run test:integration` path set (see vitest.integration.config.ts).
 */
export function assertReseedAllowed(connectionString: string): void {
  if (process.env['INTEGRATION_RESEED'] !== '1') {
    throw new Error(
      'refusing reseed: set INTEGRATION_RESEED=1 to allow destructive integration resets',
    );
  }
  const allowlist = (process.env['INTEGRATION_DB_ALLOWLIST'] ?? 'flashsale,flashsale_test').split(',');
  let dbName = '';
  try {
    dbName = new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    throw new Error('refusing reseed: unparseable DATABASE_URL');
  }
  if (!allowlist.includes(dbName)) {
    throw new Error(
      `refusing reseed of database ${JSON.stringify(dbName)} (allowlist: ${allowlist.join(',')})`,
    );
  }
}

export async function resetDb(
  client: PgClient,
  cache: { invalidate(): void },
  stockQty: number,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  assertReseedAllowed(CONNECTION_STRING);
  await client.query(`DELETE FROM purchases`);
  await client.query(`DELETE FROM stock_units`);
  await client.query(
    `INSERT INTO sale_config (id, product_name, stock_qty, starts_at, ends_at)
     VALUES (1, 'Flash Widget', $1, $2::timestamptz, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       stock_qty = EXCLUDED.stock_qty,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at`,
    [stockQty, startsAt, endsAt],
  );
  if (stockQty > 0) {
    await client.query(
      `INSERT INTO stock_units (sale_id, status)
       SELECT 1, 'available' FROM generate_series(1, $1) AS g`,
      [stockQty],
    );
  }
  cache.invalidate();
}

export async function countOf(
  client: PgClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const res = await client.query(sql, params);
  const row = res.rows[0] as { n: string } | undefined;
  return Number.parseInt(row?.n ?? '0', 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wait-with-deadline: polls cond every stepMs until true or timeoutMs
 * elapses. Replaces fixed sleeps in timing-sensitive tests so loaded
 * CI waits as long as needed but no longer.
 */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() >= deadline) return await cond();
    await sleep(stepMs);
  }
}
