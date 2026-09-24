import { describe, it, expect } from 'vitest';
import { PostgresDatabase, isUniqueViolation } from './index.js';

// SQL strings live ONLY in postgresql/index.ts; this helper asserts the
// exported mapper without opening a DB connection.
function pgError(code: string): unknown {
  return Object.assign(new Error('db'), { code });
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
      'hasPriorPurchase',
      'claimPurchase',
      'getSaleWindow',
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
});
