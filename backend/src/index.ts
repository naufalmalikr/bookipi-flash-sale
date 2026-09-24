import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './Config.ts';
import type { Application } from './Application.ts';
import { PostgresDatabase } from './repositories/database/postgresql/index.ts';
import { InMemoryCache } from './repositories/cache/in-memory/index.ts';
import { ConsoleLogger } from './repositories/logger/console/index.ts';
import { SaleServiceImpl } from './services/sale/index.ts';
import { PurchaseServiceImpl } from './services/purchase/index.ts';
import { startHttp } from './interfaces/http/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(
  here,
  'interfaces',
  'scripts',
  'postgresql',
  'migrations',
  '001_init.sql',
);

async function loadSchemaSql(): Promise<string> {
  try {
    return await readFile(SCHEMA_PATH, 'utf8');
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error(`001_init.sql not found at ${SCHEMA_PATH}`);
  }
}

export function buildApplication(): Application {
  const config = loadConfig();
  const database = new PostgresDatabase(config);
  const cache = new InMemoryCache();
  const logger = new ConsoleLogger();
  const saleService = new SaleServiceImpl(database, cache, logger);
  const purchaseService = new PurchaseServiceImpl(database, cache, logger);
  return { config, saleService, purchaseService, database, cache, logger };
}

export { startHttp };

async function main(): Promise<void> {
  const application = buildApplication();
  try {
    await application.database.ensureSchema(await loadSchemaSql());
    await application.database.upsertSaleConfig(
      application.config.saleProduct,
      application.config.stockQty,
      application.config.saleStart,
      application.config.saleEnd,
    );
    await application.database.convergeUnits(1, application.config.stockQty);
    const counts = await application.database.getCounts(1);
    if (counts.total !== application.config.stockQty) {
      application.logger.warn(
        `[boot] stock diverge: sale_config stock_qty=${String(application.config.stockQty)} but stock_units rows=${String(counts.total)} (sold=${String(counts.sold)}); status totalStock will disagree with reality`,
      );
    }
    application.logger.info(
      `[boot] sale_config stock_qty=${String(application.config.stockQty)} counts=${JSON.stringify(counts)}`,
    );
  } catch (err) {
    application.logger.error(`[boot] 500 database init failed: ${(err as Error).message}`);
    process.exit(1);
  }
  await startHttp(application);
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await main();
}
