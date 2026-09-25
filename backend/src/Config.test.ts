import { describe, it, expect } from 'vitest';
import {
  parseStrictInt,
  parsePortValue,
  parseRateLimitBuyValue,
  parseStockQtyValue,
  parsePoolMaxValue,
} from './Config.ts';

describe('parseStrictInt (m5: full-string validation, no parseInt prefix behavior)', () => {
  it('accepts plain integers', () => {
    expect(parseStrictInt('100')).toBe(100);
    expect(parseStrictInt('0')).toBe(0);
    expect(parseStrictInt('007')).toBe(7);
  });

  it('rejects parseInt-prefix inputs that Number.parseInt would silently accept', () => {
    expect(parseStrictInt('100xyz')).toBe(undefined);
    expect(parseStrictInt('10/min')).toBe(undefined);
    expect(parseStrictInt('50 ')).toBe(undefined);
    expect(parseStrictInt(' 50')).toBe(undefined);
  });

  it('rejects signs, decimals, hex, empty, and non-numeric', () => {
    for (const raw of ['-1', '+5', '1.5', '0x10', '', 'ten', '1e3']) {
      expect(parseStrictInt(raw)).toBe(undefined);
    }
  });
});

describe('port / pool / stock parsers', () => {
  it('port accepts 1-65535 only', () => {
    expect(parsePortValue('3001')).toBe(3001);
    expect(parsePortValue('0')).toBe(undefined);
    expect(parsePortValue('65536')).toBe(undefined);
    expect(parsePortValue('3001x')).toBe(undefined);
    expect(parsePortValue(undefined)).toBe(undefined);
  });

  it('stock qty accepts positive ints only (boot exits otherwise)', () => {
    expect(parseStockQtyValue('100')).toBe(100);
    expect(parseStockQtyValue('0')).toBe(undefined);
    expect(parseStockQtyValue('-5')).toBe(undefined);
    expect(parseStockQtyValue('100xyz')).toBe(undefined);
  });

  it('pool max accepts positive ints only', () => {
    expect(parsePoolMaxValue('50')).toBe(50);
    expect(parsePoolMaxValue('0')).toBe(undefined);
    expect(parsePoolMaxValue('50x')).toBe(undefined);
  });
});

describe('parseRateLimitBuyValue (0 disables, negative falls back)', () => {
  it('0 disables the limiter', () => {
    expect(parseRateLimitBuyValue('0')).toBe(0);
  });

  it('positive integers set the limit', () => {
    expect(parseRateLimitBuyValue('10')).toBe(10);
  });

  it('negative and malformed values are undefined (caller warns + falls back to 10)', () => {
    expect(parseRateLimitBuyValue('-1')).toBe(undefined);
    expect(parseRateLimitBuyValue('ten')).toBe(undefined);
    expect(parseRateLimitBuyValue('10x')).toBe(undefined);
  });
});
