import type { Cache } from '../index.js';
import { TTL_MS } from '../index.js';

interface CacheEntry {
  value: { stockRemaining: number; totalStock: number };
  expiresAt: number;
}

export class InMemoryCache implements Cache {
  private entry: CacheEntry | undefined = undefined;

  getStatus(): { value: { stockRemaining: number; totalStock: number }; cached: boolean } | undefined {
    if (this.entry === undefined) return undefined;
    if (Date.now() > this.entry.expiresAt) {
      this.entry = undefined;
      return undefined;
    }
    return { value: this.entry.value, cached: true };
  }

  setStatus(s: { stockRemaining: number; totalStock: number }): void {
    this.entry = {
      value: { stockRemaining: s.stockRemaining, totalStock: s.totalStock },
      expiresAt: Date.now() + TTL_MS,
    };
  }

  invalidate(): void {
    this.entry = undefined;
  }
}
