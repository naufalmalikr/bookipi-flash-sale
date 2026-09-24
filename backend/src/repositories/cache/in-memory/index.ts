import type { Cache } from '../index.ts';
import type { StockStatus } from '../../../entities/StockStatus.ts';
import { TTL_MS } from '../index.ts';

interface CacheEntry {
  value: StockStatus;
  expiresAt: number;
}

export class InMemoryCache implements Cache {
  private entry: CacheEntry | undefined = undefined;

  getStatus(): { value: StockStatus; cached: boolean } | undefined {
    if (this.entry === undefined) return undefined;
    if (Date.now() > this.entry.expiresAt) {
      this.entry = undefined;
      return undefined;
    }
    return { value: this.entry.value, cached: true };
  }

  setStatus(s: StockStatus): void {
    this.entry = {
      value: { stockRemaining: s.stockRemaining, totalStock: s.totalStock },
      expiresAt: Date.now() + TTL_MS,
    };
  }

  invalidate(): void {
    this.entry = undefined;
  }
}
