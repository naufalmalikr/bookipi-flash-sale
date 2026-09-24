/**
 * Postgres schema migration runner (thin script adapter).
 *
 * Reads migrations/001_init.sql co-located with this file and applies it via
 * database.ensureSchema(). Loads config ONLY via loadConfig().
 *
 * Runnable standalone:
 *   node --experimental-strip-types src/interfaces/scripts/postgresql/migrate.ts
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../../Config.ts';
import { PostgresDatabase } from '../../../repositories/database/postgresql/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(here, 'migrations', '001_init.sql');

async function loadMigrationSql(): Promise<string> {
  try {
    return await readFile(MIGRATION_PATH, 'utf8');
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error(`001_init.sql not found at ${MIGRATION_PATH}`);
  }
}

export async function migrate(): Promise<void> {
  const config = loadConfig();
  const database = new PostgresDatabase(config);
  try {
    const sql = await loadMigrationSql();
    await database.ensureSchema(sql);
    console.log('[migrate] 001_init.sql applied');
  } finally {
    await database.close();
  }
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await migrate();
}
