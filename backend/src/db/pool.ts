import pg from 'pg';

/**
 * Lazy pg connection pool (Todo 4 skeleton).
 *
 * - max from PG_POOL_MAX (default 50, per verification gate on k6 load).
 * - statement_timeout 5s + lock_timeout 2s via pool options so every
 *   connection inherits them (matches schema.sql SET defaults).
 * - Lazily constructed at module import but NEVER connects at import:
 *   the pg Pool opens sockets only on first query (Todo 13+ reuse).
 */
const poolMaxRaw: string | undefined = process.env['PG_POOL_MAX'];
let poolMax = 50;
if (poolMaxRaw !== undefined && poolMaxRaw !== '') {
  const parsed = Number.parseInt(poolMaxRaw, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    poolMax = parsed;
  }
}

const connectionString: string =
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/flashsale';

export const pool = new pg.Pool({
  connectionString,
  max: poolMax,
  // pg passes these through as connection-startup options.
  statement_timeout: '5s',
  lock_timeout: '2s',
});

/** Thin query helper so routes/services share one call shape. */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  return pool.query<T>(text, params);
}
