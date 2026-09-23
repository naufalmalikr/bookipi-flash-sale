/**
 * StockCache (Todo 8): single-entry in-memory cache for `stockRemaining`.
 *
 * - Used ONLY on read paths (GET /api/sale/status, SSE tick in Todo 9).
 * - NEVER on the purchase/claim path (Todo 7 reads sale_config + stock_units
 *   authoritatively inside a transaction).
 * - TTL 5s; invalidated on every purchase commit via invalidateStockCache()
 *   (Todo 7 calls it after commit; index.ts imports it as the call-site hook).
 */

export interface StockStatus {
  stockRemaining: number;
  totalStock: number;
}

export interface StockCache {
  getStatus(): { value: StockStatus; cached: boolean } | undefined;
  setStatus(s: StockStatus): void;
  invalidate(): void;
}

export const TTL_MS = 5000;

interface CacheEntry {
  value: StockStatus;
  expiresAt: number;
}

let entry: CacheEntry | undefined = undefined;

export const stockCache: StockCache = {
  getStatus(): { value: StockStatus; cached: boolean } | undefined {
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      entry = undefined;
      return undefined;
    }
    return { value: entry.value, cached: true };
  },

  setStatus(s: StockStatus): void {
    entry = {
      value: { stockRemaining: s.stockRemaining, totalStock: s.totalStock },
      expiresAt: Date.now() + TTL_MS,
    };
  },

  invalidate(): void {
    entry = undefined;
  },
};

/**
 * Invalidate hook for the purchase path (Todo 7).
 * Call after a successful claim-transaction commit so the next status read
 * issues a fresh COUNT and reflects the decremented stockRemaining.
 */
export function invalidateStockCache(): void {
  stockCache.invalidate();
}
