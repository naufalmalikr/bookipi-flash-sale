/** AppConfig: sole process.env reader (plus scripts). */
export interface AppConfig {
  port: number;
  databaseUrl: string;
  saleStart: string;
  saleEnd: string;
  stockQty: number;
  saleProduct: string;
  rateLimitBuy: number;
  poolMax: number;
}

const Z_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function parseZoned(name: string, raw: string | undefined, fallback: string): string {
  const value = raw === undefined || raw === '' ? fallback : raw;
  if (!Z_UTC_RE.test(value) || Number.isNaN(Date.parse(value))) {
    console.error(
      `[boot] 500 invalid ${name}=${JSON.stringify(value)} ` +
        `(must be UTC ISO-8601 with trailing Z, e.g. 2026-09-23T07:40:00Z)`,
    );
    process.exit(1);
  }
  return value;
}

/** Load and validate boot config; exits(1) on window/stock violations. */
export function loadConfig(): AppConfig {
  const now = Date.now();
  const defaultStart = new Date(now + 60_000).toISOString();
  const defaultEnd = new Date(now + 10 * 60_000).toISOString();

  const saleStart = parseZoned('SALE_START', process.env['SALE_START'], defaultStart);
  const saleEnd = parseZoned('SALE_END', process.env['SALE_END'], defaultEnd);

  if (Date.parse(saleEnd) <= Date.parse(saleStart)) {
    console.error(
      `[boot] 500 invalid SALE_END=${JSON.stringify(saleEnd)} ` +
        `(must be after SALE_START=${JSON.stringify(saleStart)})`,
    );
    process.exit(1);
  }

  const portRaw: string | undefined = process.env['PORT'];
  let port = 3001;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number.parseInt(portRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      port = parsed;
    } else {
      console.warn(`[boot] invalid PORT=${JSON.stringify(portRaw)} (must be 1-65535), falling back to 3001`);
    }
  }

  const rlRaw: string | undefined = process.env['RATE_LIMIT_BUY'];
  let rateLimitBuy = 10;
  if (rlRaw !== undefined && rlRaw !== '') {
    const parsed = Number.parseInt(rlRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      rateLimitBuy = parsed;
    } else {
      console.warn(`[boot] invalid RATE_LIMIT_BUY=${JSON.stringify(rlRaw)} (must be an integer >= 0), falling back to 10`);
    }
  }

  const stockRaw: string | undefined = process.env['STOCK_QTY'];
  let stockQty = 100;
  if (stockRaw !== undefined && stockRaw !== '') {
    const parsed = Number.parseInt(stockRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      stockQty = parsed;
    } else {
      console.error(`[boot] 500 invalid STOCK_QTY=${JSON.stringify(stockRaw)} (must be a positive integer)`);
      process.exit(1);
    }
  }

  const productRaw: string | undefined = process.env['SALE_PRODUCT'];
  const saleProduct =
    productRaw === undefined || productRaw === '' ? 'Bookipi Flash Widget' : productRaw;

  const dbRaw: string | undefined = process.env['DATABASE_URL'];
  const databaseUrl =
    dbRaw === undefined || dbRaw === '' ? 'postgres://postgres:postgres@localhost:5432/flashsale' : dbRaw;

  const poolRaw: string | undefined = process.env['PG_POOL_MAX'];
  let poolMax = 50;
  if (poolRaw !== undefined && poolRaw !== '') {
    const parsed = Number.parseInt(poolRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      poolMax = parsed;
    } else {
      console.warn(`[boot] invalid PG_POOL_MAX=${JSON.stringify(poolRaw)} (must be a positive integer), falling back to 50`);
    }
  }

  return { port, databaseUrl, saleStart, saleEnd, stockQty, saleProduct, rateLimitBuy, poolMax };
}
