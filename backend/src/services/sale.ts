/**
 * Sale window gate (Todo 6): authoritative sale_config read + pure compute.
 *
 * - getSaleState(): reads sale_config id=1 from Postgres on EVERY call
 *   (authoritative; NEVER StockCache — the cache holds only stock counts for
 *   read paths). The purchase path (Todo 7) gates on this BEFORE opening a
 *   transaction: status !== 'active' -> 403 sale-not-active.
 * - computeSaleState(): pure boundary math so Vitest covers edges without DB.
 * - Server-time rule: the server always passes Date.now(); client clocks are
 *   never trusted (the status route returns serverTime so clients can render
 *   skew, never gate on it).
 */

import { pool } from '../db/pool.js';

export type SaleStatus = 'upcoming' | 'active' | 'ended';

export interface SaleState {
  status: SaleStatus;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

/**
 * Pure window math. Boundaries are inclusive on both ends: exact start and
 * exact end both count as active (purchase allowed at the final instant).
 */
export function computeSaleState(
  startsAtMs: number,
  endsAtMs: number,
  nowMs: number,
): { status: SaleStatus } {
  if (nowMs < startsAtMs) return { status: 'upcoming' };
  if (nowMs > endsAtMs) return { status: 'ended' };
  return { status: 'active' };
}

type SaleConfigRow = {
  starts_at: Date;
  ends_at: Date;
};

/** Authoritative window read: sale_config id=1 via pool, never via cache. */
export async function getSaleState(nowMs: number = Date.now()): Promise<SaleState> {
  const res = await pool.query<SaleConfigRow>(
    `SELECT starts_at, ends_at FROM sale_config WHERE id = 1`,
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('sale-not-configured');
  const { status } = computeSaleState(
    row.starts_at.getTime(),
    row.ends_at.getTime(),
    nowMs,
  );
  return {
    status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    serverTime: new Date(nowMs).toISOString(),
  };
}
