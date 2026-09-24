/**
 * Postgres schema migration runner (thin script adapter).
 *
 * Reads migrations/001_init.sql (resolving dist + src candidates the same
 * way the legacy loader does) and applies it via database.ensureSchema().
 * Loads config ONLY via loadConfig() — the sole process.env reader.
 *
 * Runnable standalone:
 *   node --experimental-strip-types src/interfaces/scripts/postgresql/migrate.ts
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../../Config.js';
import { PostgresDatabase } from '../../../repositories/database/postgresql/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist layout mirrors src, so a co-located dist migration wins when the
// build copies static assets; otherwise fall back to the src tree (the
// Dockerfile COPYs backend/ wholesale, so src always ships next to dist).
const MIGRATION_CANDIDATES = [
  join(here, 'migrations', '001_init.sql'),
  join(here, '..', '..', '..', '..', 'src', 'interfaces', 'scripts', 'postgresql', 'migrations', '001_init.sql'),
];

async function loadMigrationSql(): Promise<string> {
  let lastErr: unknown = null;
  for (const p of MIGRATION_CANDIDATES) {
    try {
      return await readFile(p, 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('001_init.sql not found');
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
