import type { SaleConfigRow } from '../../entities/SaleConfig.ts';
import type { StockCounts } from '../../entities/StockCounts.ts';
import type { ClaimResult } from '../../entities/ClaimResult.ts';

export interface DatabaseTransaction {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface Database {
  getSaleConfig(): Promise<SaleConfigRow | undefined>;
  countAvailable(saleId: number): Promise<number>;
  getCounts(saleId: number): Promise<StockCounts>;
  findPurchaseByCanonical(saleId: number, canonical: string): Promise<{ unitId: number } | undefined>;
  claimPurchase(
    saleId: number,
    canonical: string,
    rawUserId: string,
  ): Promise<ClaimResult>;
  getSaleWindow(): Promise<{ startsAt: Date; endsAt: Date } | undefined>;
  ensureSchema(sql: string): Promise<void>;
  upsertSaleConfig(product: string, qty: number, start: string, end: string): Promise<void>;
  convergeUnits(saleId: number, targetQty: number): Promise<{ deleted: number | null; inserted: number | null }>;
  close(): Promise<void>;
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
