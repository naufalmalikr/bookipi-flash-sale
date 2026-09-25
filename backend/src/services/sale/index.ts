/**
 * SaleServiceImpl: owns window gate + status composition.
 *
 * - computeSaleState: pure boundary math, inclusive on both ends.
 * - getStatus: authoritative sale_config read via database.getSaleConfig()
 *   (throw sale-not-configured if missing), status via Date.now(), then
 *   cache.getStatus() when totalStock matches else database.countAvailable(1)
 *   + cache.setStatus(). Logs via logger.
 * - buildStatusPayload: ALWAYS fresh countAvailable (bypass cache, for SSE).
 *
 * No raw SQL, no process.env, no Fastify imports.
 */

import type { Database } from '../../repositories/database/index.ts';
import type { Cache } from '../../repositories/cache/index.ts';
import type { Logger } from '../../repositories/logger/index.ts';
import type { SaleConfigRow } from '../../entities/SaleConfig.ts';
import type { SaleService } from '../index.ts';
import { computeGate } from '../../utilities/index.ts';
import type {
  SaleStatus,
  GetStatusOutput,
} from '../../models/sale/sale.contract.ts';
import { SALE_ID } from '../../entities/index.ts';

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
  ): { status: SaleStatus } {
    // The boundary verdict is shared (utilities/computeGate); this derives
    // the status label from it so the claim gate and the status endpoint
    // cannot disagree about where the window opens and closes.
    if (computeGate(s, e, n)) return { status: 'active' };
    if (n < s) return { status: 'upcoming' };
    return { status: 'ended' };
  }

  async getStatus(nowMs: number = Date.now()): Promise<GetStatusOutput> {
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
      this.logger.info('[status] cache miss: countAvailable');
      stockRemaining = await this.database.countAvailable(SALE_ID);
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

  async buildStatusPayload(nowMs: number = Date.now()): Promise<GetStatusOutput> {
    const cfg: SaleConfigRow | undefined = await this.database.getSaleConfig();
    if (cfg === undefined) throw new Error('sale-not-configured');
    const { status } = this.computeSaleState(
      cfg.startsAt.getTime(),
      cfg.endsAt.getTime(),
      nowMs,
    );
    // SSE path: ALWAYS fresh count, deliberately bypassing the cache so
    // commit pushes never serve a stale cached count.
    const stockRemaining: number = await this.database.countAvailable(SALE_ID);
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
