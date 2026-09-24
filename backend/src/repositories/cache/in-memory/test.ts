import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryCache } from './index.js';
import { TTL_MS } from '../index.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('InMemoryCache', () => {
  it('exports TTL_MS=5000', () => {
    expect(TTL_MS).toBe(5000);
  });

  it('miss before set', () => {
    expect(new InMemoryCache().getStatus()).toBeUndefined();
  });

  it('set then hit with cached:true', () => {
    const c = new InMemoryCache();
    c.setStatus({ stockRemaining: 7, totalStock: 100 });
    expect(c.getStatus()).toEqual({ value: { stockRemaining: 7, totalStock: 100 }, cached: true });
  });

  it('invalidate clears', () => {
    const c = new InMemoryCache();
    c.setStatus({ stockRemaining: 7, totalStock: 100 });
    c.invalidate();
    expect(c.getStatus()).toBeUndefined();
  });

  it('expires after TTL via fake timers', () => {
    vi.useFakeTimers();
    const c = new InMemoryCache();
    c.setStatus({ stockRemaining: 3, totalStock: 10 });
    vi.advanceTimersByTime(TTL_MS + 1);
    expect(c.getStatus()).toBeUndefined();
  });
});
