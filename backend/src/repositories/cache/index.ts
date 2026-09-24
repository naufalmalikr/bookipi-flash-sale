export interface CacheStatusValue {
  stockRemaining: number;
  totalStock: number;
}

export interface Cache {
  getStatus(): { value: { stockRemaining: number; totalStock: number }; cached: boolean } | undefined;
  setStatus(s: { stockRemaining: number; totalStock: number }): void;
  invalidate(): void;
}

export const TTL_MS = 5000;
