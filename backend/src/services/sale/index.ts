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

import type { Database } from '../../repositories/database/index.js';
import type { Cache } from '../../repositories/cache/index.js';
import type { Logger } from '../../repositories/logger/index.js';
import type { SaleConfigRow } from '../../entities/SaleConfig.js';
import type { SaleService } from '../index.js';
import type { SaleStatusResponse } from '../../models/responses/sale.response.js';

export class SaleServiceImpl implements SaleService {
  private database: Database;
  private cache: Cache;
  private logger: Logger;

  constructor(database: Database, cache: Cache, logger: Logger) {
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

  async getStatus(nowMs: number = Date.now()): Promise<SaleStatusResponse> {
    const cfg: SaleConfigRow | undefined = await this.database.getSaleConfig();
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

  async buildStatusPayload(nowMs: number = Date.now()): Promise<SaleStatusResponse> {
    const cfg: SaleConfigRow | undefined = await this.database.getSaleConfig();
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
