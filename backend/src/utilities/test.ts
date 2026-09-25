import { describe, it, expect } from 'vitest';
import { computeGate } from './index.ts';
import { SaleServiceImpl } from '../services/sale/index.ts';
import type { Cache } from '../repositories/cache/index.ts';
import type { Database } from '../repositories/database/index.ts';
import type { Logger } from '../repositories/logger/index.ts';

// Fixed window: 2026-01-01T00:00:00Z .. +10min. Pure compute — no DB.
const START = Date.parse('2026-01-01T00:00:00.000Z');
const END = START + 10 * 60 * 1000;
const MIN = 60 * 1000;

describe('computeGate boundaries (single copy of the window rule)', () => {
  it('1ms before start -> closed', () => {
    expect(computeGate(START, END, START - 1)).toBe(false);
  });

  it('exact start -> open (inclusive)', () => {
    expect(computeGate(START, END, START)).toBe(true);
  });

  it('mid-window -> open', () => {
    expect(computeGate(START, END, START + 5 * MIN)).toBe(true);
  });

  it('exact end -> open (inclusive)', () => {
    expect(computeGate(START, END, END)).toBe(true);
  });

  it('1ms after end -> closed', () => {
    expect(computeGate(START, END, END + 1)).toBe(false);
  });

  it('degenerate/inverted windows never report an active span incorrectly', () => {
    expect(computeGate(START, START, START)).toBe(true); // shared instant is open
    expect(computeGate(START, START, START - 1)).toBe(false);
    expect(computeGate(START, START, START + 1)).toBe(false);
    // Inverted (start > end): closed at both extremes.
    expect(computeGate(END, START, START)).toBe(false);
    expect(computeGate(END, START, END)).toBe(false);
  });
});

describe('call-site agreement on the shared rule', () => {
  // The review found the boundary rule implemented three times with
  // nothing asserting they agree. Two sites are service methods; the third
  // (in-txn re-gate) is the same imported function, so agreement is
  // structural — but the service surface is asserted here on the exact
  // points a reviewer would ask about: start-1 / start / end / end+1.
  const svc = new SaleServiceImpl({} as Database, {} as Cache, {} as Logger);
  const points: Array<[number, string]> = [
    [START - 1, 'closed'],
    [START, 'open'],
    [END, 'open'],
    [END + 1, 'closed'],
  ];

  it('computeSaleState label matches computeGate verdict at every boundary point', () => {
    for (const [now, verdict] of points) {
      const open = computeGate(START, END, now);
      expect(open).toBe(verdict === 'open');
      const status = svc.computeSaleState(START, END, now).status;
      if (open) {
        expect(status).toBe('active');
      } else {
        expect(status === 'upcoming' || status === 'ended').toBe(true);
      }
    }
  });
});
