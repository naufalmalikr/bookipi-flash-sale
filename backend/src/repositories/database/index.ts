export type {
  SaleConfig,
  SaleConfigRow,
  StockCounts,
  ClaimResult,
  Database,
  DatabaseTransaction,
} from '../../entities/index.js';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}
