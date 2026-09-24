/**
 * SaleServiceImpl: owns window gate + status composition.
 *
 * - computeSaleState: pure boundary math, verbatim from
 *   backend/src/services/sale.ts (inclusive on both ends).
 * - getStatus: authoritative sale_config read via database.getSaleConfig()
 *   (throw sale-not-configured if missing), status via Date.now(), then
 *   cache.getStatus() when totalStock matches else database.countAvailable(1)
 *   + cache.setStatus(). Logs via logger.
 * - buildStatusPayload: ALWAYS fresh countAvailable (bypass cache, for SSE).
 *
 * No raw SQL, no process.env, no Fastify imports.
 */

import type { SaleService } from '../index.js';

export class SaleServiceImpl implements SaleService {
  private database: any;
  private cache: any;
  private logger: any;

  constructor(database: any, cache: any, logger: any) {
    this.database = database;
    this.cache = cache;
    this.logger = logger;
  }

  computeSaleState(
    s: number,
    e: number,
    n: number,
  ): { status: 'upcoming' | 'active' | 'ended' } {
    if (n < s) return { status: 'upcoming' };
    if (n > e) return { status: 'ended' };
    return { status: 'active' };
  }

  async getStatus(nowMs: number = Date.now()): Promise<{
    status: string;
    stockRemaining: number;
    totalStock: number;
    startsAt: string;
    endsAt: string;
    serverTime: string;
  }> {
    const cfg:
      | { productName: string; stockQty: number; startsAt: Date; endsAt: Date }
      | undefined = await this.database.getSaleConfig();
    if (cfg === undefined) throw new Error('sale-not-configured');
    const { status } = this.computeSaleState(
      cfg.startsAt.getTime(),
      cfg.endsAt.getTime(),
      nowMs,
    );
    const totalStock = cfg.stockQty;

    const hit = this.cache.getStatus();
    let stockRemaining: number;
    if (hit !== undefined && hit.value.totalStock === totalStock) {
      stockRemaining = hit.value.stockRemaining;
    } else {
      this.logger?.info?.('[status] cache miss: countAvailable');
      stockRemaining = await this.database.countAvailable(1);
      this.cache.setStatus({ stockRemaining, totalStock });
    }

    return {
      status,
      stockRemaining,
      totalStock,
      startsAt: cfg.startsAt.toISOString(),
      endsAt: cfg.endsAt.toISOString(),
      serverTime: new Date(nowMs).toISOString(),
    };
  }

  async buildStatusPayload(nowMs: number = Date.now()): Promise<{
    status: string;
    stockRemaining: number;
    totalStock: number;
    startsAt: string;
    endsAt: string;
    serverTime: string;
  }> {
    const cfg:
      | { productName: string; stockQty: number; startsAt: Date; endsAt: Date }
      | undefined = await this.database.getSaleConfig();
    if (cfg === undefined) throw new Error('sale-not-configured');
    const { status } = this.computeSaleState(
      cfg.startsAt.getTime(),
      cfg.endsAt.getTime(),
      nowMs,
    );
    // SSE path: ALWAYS fresh count, deliberately bypassing the cache so
    // commit pushes never serve a stale cached count.
    const stockRemaining: number = await this.database.countAvailable(1);
    return {
      status,
      stockRemaining,
      totalStock: cfg.stockQty,
      startsAt: cfg.startsAt.toISOString(),
      endsAt: cfg.endsAt.toISOString(),
      serverTime: new Date(nowMs).toISOString(),
    };
  }
}
