import type { StockStatus } from './StockStatus.js';

export interface Cache {
  getStatus(): { value: StockStatus; cached: boolean } | undefined;
  setStatus(s: StockStatus): void;
  invalidate(): void;
}

export const TTL_MS = 5000;
