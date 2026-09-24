/**
 * Postgres seed runner (thin script adapter).
 *
 * Mirrors the legacy migrateAndSeed converge logic but uses ONLY Database
 * domain methods — zero raw SQL here (upsertSaleConfig + convergeUnits +
 * getCounts). Loads config ONLY via loadConfig() — the sole process.env
 * reader. Idempotent: safe to re-run (upsert + top-up/shrink).
 *
 * Runnable standalone:
 *   node --experimental-strip-types src/interfaces/scripts/postgresql/seed.ts
 */

import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../../Config.ts';
import { PostgresDatabase } from '../../../repositories/database/postgresql/index.ts';

export async function seed(): Promise<void> {
  const config = loadConfig();
  const database = new PostgresDatabase(config);
  try {
    await database.upsertSaleConfig(
      config.saleProduct,
      config.stockQty,
      config.saleStart,
      config.saleEnd,
    );
    const converged = await database.convergeUnits(1, config.stockQty);
    const counts = await database.getCounts(1);
    if (counts.total !== config.stockQty) {
      console.warn(
        `[seed] stock diverge: sale_config stock_qty=${String(config.stockQty)} but stock_units rows=${String(counts.total)} (sold=${String(counts.sold)}); status totalStock will disagree with reality`,
      );
    }
    console.log(
      `[seed] sale_config stock_qty=${String(config.stockQty)} units_deleted=${String(converged.deleted)} units_inserted=${String(converged.inserted)} counts=${JSON.stringify(counts)}`,
    );
  } finally {
    await database.close();
  }
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await seed();
}
