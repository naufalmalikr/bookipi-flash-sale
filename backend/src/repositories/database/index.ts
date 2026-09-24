/**
 * Database repository contract.
 *
 * Services must use these domain methods and never write raw SQL.
 * Raw SQL lives ONLY in `postgresql/index.ts` (+ test helpers).
 */

export interface DatabaseTransaction {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

export interface SaleConfig {
  productName: string;
  stockQty: number;
  startsAt: Date;
  endsAt: Date;
}

export interface StockCounts {
  total: number;
  sold: number;
  available: number;
}

export type ClaimResult = { ok: true; unitId: number } | { ok: false; error: 'sold-out' | 'already-purchased' };

export interface Database {
  getSaleConfig(): Promise<{ productName: string; stockQty: number; startsAt: Date; endsAt: Date } | undefined>;
  countAvailable(saleId: number): Promise<number>;
  getCounts(saleId: number): Promise<{ total: number; sold: number; available: number }>;
  findPurchaseByCanonical(saleId: number, canonical: string): Promise<{ unitId: number } | undefined>;
  hasPriorPurchase(saleId: number, canonical: string): Promise<boolean>;
  claimPurchase(
    saleId: number,
    canonical: string,
    rawUserId: string,
  ): Promise<{ ok: true; unitId: number } | { ok: false; error: 'sold-out' | 'already-purchased' }>;
  getSaleWindow(): Promise<{ startsAt: Date; endsAt: Date } | undefined>;
  ensureSchema(sql: string): Promise<void>;
  upsertSaleConfig(product: string, qty: number, start: string, end: string): Promise<void>;
  convergeUnits(saleId: number, targetQty: number): Promise<{ deleted: number | null; inserted: number | null }>;
  close(): Promise<void>;
}
