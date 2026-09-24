import { describe, it, expect } from 'vitest';
import { SaleServiceImpl } from './index.ts';
import type { Cache } from '../../repositories/cache/index.ts';
import type { Database } from '../../repositories/database/index.ts';
import type { Logger } from '../../repositories/logger/index.ts';

// Service-level vectors ported verbatim from backend/src/services/sale.test.ts.
// computeSaleState lives on the instance; constructor deps unused for pure math.
const svc = new SaleServiceImpl({} as Database, {} as Cache, {} as Logger);

// Fixed window: 2026-01-01T00:00:00Z .. +10min. Pure compute — no DB.
const START = Date.parse('2026-01-01T00:00:00.000Z');
const END = START + 10 * 60 * 1000;
const MIN = 60 * 1000;

describe('computeSaleState boundaries', () => {
  it('60s before start -> upcoming', () => {
    expect(svc.computeSaleState(START, END, START - MIN).status).toBe('upcoming');
  });

  it('exact start -> active (inclusive)', () => {
    expect(svc.computeSaleState(START, END, START).status).toBe('active');
  });

  it('mid-window -> active', () => {
    expect(svc.computeSaleState(START, END, START + 5 * MIN).status).toBe('active');
  });

  it('exact end -> active (inclusive)', () => {
    expect(svc.computeSaleState(START, END, END).status).toBe('active');
  });

  it('60s after end -> ended', () => {
    expect(svc.computeSaleState(START, END, END + MIN).status).toBe('ended');
  });

  it('degenerate window (endsAt <= startsAt) resolves deterministically', () => {
    // Shared instant is still active (start-inclusive, end-inclusive);
    // 1ms before -> upcoming, 1ms after -> ended. Callers must ensure
    // endsAt > startsAt via env validation; compute never throws.
    expect(svc.computeSaleState(START, START, START).status).toBe('active');
    expect(svc.computeSaleState(START, START, START - 1).status).toBe('upcoming');
    expect(svc.computeSaleState(START, START, START + 1).status).toBe('ended');
    // Inverted window: now < start dominates -> upcoming; now >= start
    // implies now > end -> ended. No active span exists.
    expect(svc.computeSaleState(END, START, START).status).toBe('upcoming');
    expect(svc.computeSaleState(END, START, END).status).toBe('ended');
  });

  it('server-time skew immunity: gate uses server now, not client now', () => {
    // Server mid-window: even a client clock 1h fast (past end) or 1h slow
    // (before start) must NOT change the server verdict — the server always
    // passes Date.now(), so compute with server now stays active.
    const serverNow = START + 5 * MIN;
    const skewedFast = END + 60 * MIN; // client 1h fast
    const skewedSlow = START - 60 * MIN; // client 1h slow
    expect(svc.computeSaleState(START, END, serverNow).status).toBe('active');
    // The skewed *client* values would mis-gate if trusted — this documents
    // why server time is authoritative and client time is never passed in.
    expect(svc.computeSaleState(START, END, skewedFast).status).toBe('ended');
    expect(svc.computeSaleState(START, END, skewedSlow).status).toBe('upcoming');
  });
});
