import type { SaleConfigRow } from '../../entities/SaleConfig.ts';
import type { StockCounts } from '../../entities/StockCounts.ts';
import type { ClaimResult } from '../../entities/ClaimResult.ts';

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

function constraintOf(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('constraint' in err)) return '';
  const c = (err as { constraint?: unknown }).constraint;
  return typeof c === 'string' ? c : '';
}

/** UNIQUE(sale_id, canonical_user_id) — the one-per-user backstop. */
export function isCanonicalUserUniqueViolation(err: unknown): boolean {
  return isUniqueViolation(err) && constraintOf(err).includes('canonical_user_id');
}

/**
 * UNIQUE(unit_id) — the catastrophic double-claim backstop. Must never fire:
 * every claim holds its row via FOR UPDATE in the same txn. A hit here is an
 * internal error, never an already-purchased.
 */
export function isUnitUniqueViolation(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const c = constraintOf(err);
  return c.includes('unit_id') && !c.includes('canonical_user_id');
}
