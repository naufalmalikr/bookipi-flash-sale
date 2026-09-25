import { describe, it, expect } from 'vitest';
import {
  PostgresDatabase,
  isUniqueViolation,
  isCanonicalUserUniqueViolation,
  isUnitUniqueViolation,
} from './index.ts';

// SQL strings live ONLY in postgresql/index.ts; this helper asserts the
// exported mapper without opening a DB connection.
function pgError(code: string, constraint?: string): unknown {
  return constraint === undefined
    ? Object.assign(new Error('db'), { code })
    : Object.assign(new Error('db'), { code, constraint });
}

describe('PostgresDatabase offline', () => {
  it('class exists and exposes domain methods', () => {
    expect(typeof PostgresDatabase).toBe('function');
    const proto = PostgresDatabase.prototype as unknown as Record<string, unknown>;
    for (const m of [
      'getSaleConfig',
      'countAvailable',
      'getCounts',
      'findPurchaseByCanonical',
      'claimPurchase',
      'ensureSchema',
      'upsertSaleConfig',
      'convergeUnits',
      'close',
    ]) {
      expect(typeof proto[m]).toBe('function');
    }
  });

  it('maps SQLSTATE 23505 to unique violation', () => {
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
    expect(isUniqueViolation(pgError('40001'))).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it('routes 23505 by constraint name (m1: unit double-claim never masks as already-purchased)', () => {
    const canonical = pgError('23505', 'purchases_sale_id_canonical_user_id_key');
    expect(isCanonicalUserUniqueViolation(canonical)).toBe(true);
    expect(isUnitUniqueViolation(canonical)).toBe(false);
    const unit = pgError('23505', 'purchases_unit_id_key');
    expect(isUnitUniqueViolation(unit)).toBe(true);
    expect(isCanonicalUserUniqueViolation(unit)).toBe(false);
    expect(isCanonicalUserUniqueViolation(pgError('40001'))).toBe(false);
    expect(isUnitUniqueViolation(pgError('23505'))).toBe(false);
  });
});
