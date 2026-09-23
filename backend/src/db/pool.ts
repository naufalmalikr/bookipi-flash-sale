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
  } else {
    console.warn(
      `[boot] invalid PG_POOL_MAX=${JSON.stringify(poolMaxRaw)} (must be a positive integer), falling back to 50`,
    );
  }
}

const connectionString: string =
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/flashsale';

export const pool = new pg.Pool({
  connectionString,
  max: poolMax,
  // pg expects these in MILLISECONDS as numbers (a string like '5s' is
  // coerced to 5, i.e. a 5ms timeout that cancels every real query).
  statement_timeout: 5000,
  lock_timeout: 2000,
});

/** Thin query helper so routes/services share one call shape. */
export async function query<T extends Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number | null }> {
  return pool.query<T>(text, params);
}
