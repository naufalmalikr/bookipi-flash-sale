import type { StockStatus } from '../../entities/StockStatus.ts';

export interface Cache {
  getStatus(): { value: StockStatus; cached: boolean } | undefined;
  setStatus(s: StockStatus): void;
  invalidate(): void;
}

export const TTL_MS = 5000;
