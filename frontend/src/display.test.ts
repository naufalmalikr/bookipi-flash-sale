import { describe, it, expect } from 'vitest';
import { toneFor, formatDelta } from './display';

describe('toneFor maps every server code to a distinct alert tone', () => {
  it('maps known codes', () => {
    expect(toneFor('purchased')).toBe('alert-success');
    expect(toneFor('already-purchased')).toBe('alert-repeat');
    expect(toneFor('sold-out')).toBe('alert-soldout');
    expect(toneFor('sale-not-active')).toBe('alert-inactive');
    expect(toneFor('invalid-userId')).toBe('alert-invalid');
    expect(toneFor('rate-limited')).toBe('alert-rate');
    expect(toneFor('not-purchased')).toBe('alert-notpurchased');
  });

  it('falls back to alert-error for unknown codes', () => {
    expect(toneFor('network-error')).toBe('alert-error');
    expect(toneFor('')).toBe('alert-error');
  });
});

describe('formatDelta renders countdown text', () => {
  it('renders hh:mm:ss under a day', () => {
    expect(formatDelta(0)).toBe('00:00:00');
    expect(formatDelta(1000)).toBe('00:00:01');
    expect(formatDelta(61_000)).toBe('00:01:01');
    expect(formatDelta(3_661_000)).toBe('01:01:01');
  });

  it('renders day form at 24h+', () => {
    expect(formatDelta(86_400_000)).toBe('1d 00h 00m 00s');
    expect(formatDelta(90_061_000)).toBe('1d 01h 01m 01s');
  });

  it('clamps negative input to zero', () => {
    expect(formatDelta(-5000)).toBe('00:00:00');
  });

  it('floors sub-second input', () => {
    expect(formatDelta(999)).toBe('00:00:00');
    expect(formatDelta(1999)).toBe('00:00:01');
  });
});
