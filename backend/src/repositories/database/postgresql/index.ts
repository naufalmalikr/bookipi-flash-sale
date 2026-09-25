/**
 * PostgresDatabase: raw SQL lives ONLY here (repository layer).
 * Domain methods so services never write SQL.
 */

import pg from 'pg';
import type { Pool as PgPool, PoolClient as PgPoolClient } from 'pg';
import type { Database } from '../index.ts';
import { isUniqueViolation, isCanonicalUserUniqueViolation, isUnitUniqueViolation } from '../index.ts';
// computeGate is a pure function (no SQL, no I/O). Importing it here keeps
// the in-transaction window re-gate byte-identical to the pre-transaction
// gate and the status endpoint — the rule lives in one place.
import { computeGate } from '../../../utilities/index.ts';
import { SALE_ID } from '../../../entities/index.ts';

// ../../Config.js does not exist yet — local shape mirrors
// AppConfig{databaseUrl:string, poolMax:number}. Config is injected via
// constructor; never read process.env here.
export interface PostgresConfig {
  databaseUrl: string;
  poolMax: number;
}

export { isUniqueViolation, isCanonicalUserUniqueViolation, isUnitUniqueViolation };

export class PostgresDatabase implements Database {
  private pool: PgPool;

  constructor(config: PostgresConfig) {
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      statement_timeout: 5000,
      lock_timeout: 2000,
    });
  }

  async getSaleConfig(): Promise<
    { productName: string; stockQty: number; startsAt: Date; endsAt: Date } | undefined
  > {
    const res = await this.pool.query<{
      product_name: string;
      stock_qty: number;
      starts_at: Date;
      ends_at: Date;
    }>(
      `SELECT product_name, stock_qty, starts_at, ends_at
       FROM sale_config WHERE id = $1`,
      [SALE_ID],
    );
    const row = res.rows[0];
    if (row === undefined) return undefined;
    return {
      productName: row.product_name,
      stockQty: row.stock_qty,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  async countAvailable(saleId: number): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM stock_units
       WHERE sale_id = $1 AND status = 'available'`,
      [saleId],
    );
    return Number.parseInt(res.rows[0]?.n ?? '0', 10);
  }

  async getCounts(saleId: number): Promise<{ total: number; sold: number; available: number }> {
    const res = await this.pool.query<{ total: number; sold: number; available: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'available')::int AS available,
         COUNT(*) FILTER (WHERE status = 'sold')::int AS sold
       FROM stock_units WHERE sale_id = $1`,
      [saleId],
    );
    const row = res.rows[0];
    if (row === undefined) return { total: 0, sold: 0, available: 0 };
    return { total: row.total, sold: row.sold, available: row.available };
  }

  async findPurchaseByCanonical(
    saleId: number,
    canonical: string,
  ): Promise<{ unitId: number } | undefined> {
    const res = await this.pool.query<{ unit_id: number }>(
      `SELECT unit_id FROM purchases
        WHERE sale_id = $1 AND canonical_user_id = $2 LIMIT 1`,
      [saleId, canonical],
    );
    const row = res.rows[0];
    if (row === undefined) return undefined;
    return { unitId: row.unit_id };
  }

  async claimPurchase(
    saleId: number,
    canonical: string,
    rawUserId: string,
  ): Promise<{ ok: true; unitId: number } | { ok: false; error: 'sold-out' | 'already-purchased' }> {
    let client: PgPoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const win = await client.query<{ starts_at: Date; ends_at: Date }>(
        `SELECT starts_at, ends_at FROM sale_config WHERE id = $1`,
        [saleId],
      );
      const winRow = win.rows[0];
      if (winRow === undefined) {
        await client.query('ROLLBACK');
        throw new Error('sale-not-configured');
      }
      // In-transaction window re-gate: same shared boundary rule as the
      // pre-txn gate and the status endpoint (utilities/computeGate).
      const nowMs = Date.now();
      if (!computeGate(winRow.starts_at.getTime(), winRow.ends_at.getTime(), nowMs)) {
        await client.query('ROLLBACK');
        throw new Error('sale-not-active');
      }
      const claimed = await client.query<{ id: number }>(
        `SELECT id FROM stock_units
          WHERE sale_id = $1 AND status = 'available'
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [saleId],
      );
      const unitRow = claimed.rows[0];
      if (unitRow === undefined) {
        await client.query('ROLLBACK');
        // Exhausted. Deliberately no "did this buyer just win elsewhere?"
        // re-check here. The pre-txn findPurchaseByCanonical fast path
        // already answers that truthfully for every duplicate whose
        // purchase has committed, and while stock remains a concurrent
        // duplicate dies on UNIQUE(sale_id, canonical_user_id) ->
        // already-purchased. The one residual hole is a same-user request
        // that passes the fast path in the instant before the winner's
        // commit AND finds no free unit afterwards: it is then told
        // `sold-out` instead of the more precise `already-purchased`. That
        // is a mislabel, not a lost guarantee — the UNIQUE constraint plus
        // the all-or-nothing claim transaction still make one-purchase-per-
        // user and zero-oversell structurally impossible.
        return { ok: false, error: 'sold-out' };
      }
      const unitId: number = unitRow.id;
      const updated = await client.query(
        `UPDATE stock_units SET status = 'sold', sold_at = now()
          WHERE id = $1 AND status = 'available'`,
        [unitId],
      );
      if (updated.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Error('unit-already-claimed');
      }
      await client.query(
        `INSERT INTO purchases (sale_id, canonical_user_id, unit_id, raw_user_id)
         VALUES ($1, $2, $3, $4)`,
        [saleId, canonical, unitId, rawUserId],
      );
      await client.query('COMMIT');
      return { ok: true, unitId };
    } catch (err) {
      try {
        await client?.query('ROLLBACK');
      } catch {
        // ROLLBACK failing leaves nothing actionable; fall through.
      }
      if (err instanceof Error && err.message === 'sale-not-active') throw err;
      if (err instanceof Error && err.message === 'unit-already-claimed') throw err;
      if (isUnitUniqueViolation(err)) {
        throw new Error('unit-double-claim');
      }
      if (isCanonicalUserUniqueViolation(err)) return { ok: false, error: 'already-purchased' };
      if (isUniqueViolation(err)) return { ok: false, error: 'already-purchased' };
      throw err;
    } finally {
      client?.release();
    }
  }

  async ensureSchema(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async upsertSaleConfig(product: string, qty: number, start: string, end: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sale_config (id, product_name, stock_qty, starts_at, ends_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         product_name = EXCLUDED.product_name,
         stock_qty = EXCLUDED.stock_qty,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at`,
      [SALE_ID, product, qty, start, end],
    );
  }

  async convergeUnits(
    saleId: number,
    targetQty: number,
  ): Promise<{ deleted: number | null; inserted: number | null }> {
    const shrunk = await this.pool.query<{ id: number }>(
      `WITH sold AS (
         SELECT COUNT(*)::int AS n FROM stock_units
         WHERE sale_id = $1 AND status = 'sold'
       ),
       ranked AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn FROM stock_units
         WHERE sale_id = $1 AND status = 'available'
       )
       DELETE FROM stock_units WHERE id IN (
         SELECT ranked.id FROM ranked, sold
         WHERE ranked.rn > GREATEST($2 - sold.n, 0)
       ) RETURNING id`,
      [saleId, targetQty],
    );
    const topped = await this.pool.query<{ id: number }>(
      `INSERT INTO stock_units (sale_id, status)
       SELECT $1, 'available'
       FROM generate_series(
         1,
         GREATEST($2 - (SELECT COUNT(*)::int FROM stock_units WHERE sale_id = $1), 0)
       ) AS g
       RETURNING id`,
      [saleId, targetQty],
    );
    return { deleted: shrunk.rowCount, inserted: topped.rowCount };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
