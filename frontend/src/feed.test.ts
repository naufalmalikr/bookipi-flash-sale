import { describe, it, expect } from 'vitest';
import {
  createFeedController,
  clockOffsetFrom,
  MAX_BACKOFF_MS,
  POLL_FALLBACK_MS,
  type FeedDeps,
  type FeedEventSource,
  type FeedController,
  type FeedState,
} from './feed';
import type { StatusPayload } from './api';

const NOW = 1_000_000;

function makeStatus(offsetMs = 0): StatusPayload {
  return {
    status: 'active',
    stockRemaining: 5,
    totalStock: 100,
    startsAt: new Date(NOW - 60_000).toISOString(),
    endsAt: new Date(NOW + 60_000).toISOString(),
    serverTime: new Date(NOW + offsetMs).toISOString(),
  };
}

class FakeSource implements FeedEventSource {
  readonly url: string;
  closed = false;
  private statusListeners: Array<(ev: { data: unknown }) => void> = [];
  private errorListener: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: 'status', listener: (ev: { data: unknown }) => void): void {
    if (type === 'status') this.statusListeners.push(listener);
  }

  onError(listener: () => void): void {
    this.errorListener = listener;
  }

  close(): void {
    this.closed = true;
  }

  emitStatus(s: StatusPayload): void {
    for (const l of this.statusListeners) {
      l({ data: JSON.stringify(s) });
    }
  }

  emitRaw(raw: string): void {
    for (const l of this.statusListeners) {
      l({ data: raw });
    }
  }

  emitError(): void {
    this.errorListener?.();
  }
}

interface TimerRec {
  id: number;
  fn: () => void;
  delay: number;
  kind: 'timeout' | 'interval';
  cleared: boolean;
}

class FakeTimers {
  private seq = 0;
  readonly list: TimerRec[] = [];

  setTimeout(fn: () => void, ms: number): number {
    this.list.push({ id: ++this.seq, fn, delay: ms, kind: 'timeout', cleared: false });
    return this.seq;
  }

  clearTimeout(id: number): void {
    for (const rec of this.list) {
      if (rec.id === id && rec.kind === 'timeout') rec.cleared = true;
    }
  }

  setInterval(fn: () => void, ms: number): number {
    this.list.push({ id: ++this.seq, fn, delay: ms, kind: 'interval', cleared: false });
    return this.seq;
  }

  clearInterval(id: number): void {
    for (const rec of this.list) {
      if (rec.id === id && rec.kind === 'interval') rec.cleared = true;
    }
  }

  pending(kind: TimerRec['kind']): TimerRec[] {
    return this.list.filter((t) => t.kind === kind && !t.cleared);
  }

  fireTimeout(id: number): void {
    const rec = this.list.find((t) => t.id === id);
    // A fired one-shot reconnect is spent; late double-fires are no-ops.
    if (rec === undefined || rec.kind !== 'timeout' || rec.cleared) return;
    rec.cleared = true;
    rec.fn();
  }
}

interface Harness {
  states: FeedState[];
  statuses: Array<{ s: StatusPayload; offset: number | null }>;
  loadErrors: string[];
  timers: FakeTimers;
  sources: FakeSource[];
  controller: FeedController;
}

function createHarness(options: { throwInFactory?: boolean; fetchFails?: boolean } = {}): Harness {
  const states: FeedState[] = [];
  const statuses: Array<{ s: StatusPayload; offset: number | null }> = [];
  const loadErrors: string[] = [];
  const timers = new FakeTimers();
  const sources: FakeSource[] = [];
  const deps: FeedDeps = {
    url: '/api/sale/events',
    fetchStatus: async () => {
      if (options.fetchFails) throw new Error('boom');
      return makeStatus(5000);
    },
    now: () => NOW,
    makeEventSource: (url) => {
      if (options.throwInFactory) throw new Error('no EventSource here');
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    onState: (state) => states.push(state),
    onStatus: (s, offset) => statuses.push({ s, offset }),
    onLoadError: (message) => loadErrors.push(message),
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimeout: (id) => timers.clearTimeout(id),
    setInterval: (fn, ms) => timers.setInterval(fn, ms),
    clearInterval: (id) => timers.clearInterval(id),
  };
  return { states, statuses, loadErrors, timers, sources, controller: createFeedController(deps) };
}

describe('FeedController', () => {
  it('connects EventSource to the injected url on construction', () => {
    const h = createHarness();
    expect(h.sources.length).toBe(1);
    expect(h.sources[0]?.url).toBe('/api/sale/events');
  });

  it('first status frame reports live-sse, applies status + clock offset, starts no timers', () => {
    const h = createHarness();
    h.sources[0]?.emitStatus(makeStatus(5000));
    expect(h.states).toEqual(['live-sse']);
    expect(h.statuses.length).toBe(1);
    // serverTime is NOW+5000, local NOW -> offset -5000.
    expect(h.statuses[0]?.offset).toBe(-5000);
    expect(h.timers.pending('interval')).toHaveLength(0);
    expect(h.timers.pending('timeout')).toHaveLength(0);
  });

  it('initial fetch failure surfaces onLoadError without breaking the SSE connect', async () => {
    const h = createHarness({ fetchFails: true });
    // The error handler runs on a later microtask; flush it before asserting.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(h.loadErrors).toEqual(['boom']);
    expect(h.sources.length).toBe(1);
  });

  it('onerror closes the source, reports polling, schedules 5s poll + 1s reconnect', () => {
    const h = createHarness();
    h.sources[0]?.emitError();
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.states).toEqual(['polling']);
    const polls = h.timers.pending('interval');
    expect(polls).toHaveLength(1);
    expect(polls[0]?.delay).toBe(POLL_FALLBACK_MS);
    const reconnects = h.timers.pending('timeout');
    expect(reconnects).toHaveLength(1);
    expect(reconnects[0]?.delay).toBe(1000);
  });

  it('backoff doubles on repeated failures and caps at 10s', () => {
    const h = createHarness();
    const delays: number[] = [];
    let fired = 0;
    while (fired < 6) {
      const active = h.sources.find((s) => !s.closed);
      active?.emitError();
      const pending = h.timers.pending('timeout');
      expect(pending).toHaveLength(1); // never more than one reconnect in flight
      delays.push(pending[0]?.delay ?? -1);
      h.timers.fireTimeout(pending[0]?.id ?? 0);
      fired += 1;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(h.sources.length).toBe(7); // one new source per fired reconnect
  });

  it('a good status frame resets backoff to 1s, clears poll fallback, reports live-sse', () => {
    const h = createHarness();
    h.sources[0]?.emitError();
    const firstReconnect = h.timers.pending('timeout')[0];
    h.timers.fireTimeout(firstReconnect?.id ?? 0);
    expect(h.timers.pending('interval')).toHaveLength(1); // still polling
    h.sources[1]?.emitStatus(makeStatus());
    expect(h.states).toEqual(['polling', 'live-sse']);
    expect(h.timers.pending('interval')).toHaveLength(0); // fallback stopped
    h.sources[1]?.emitError();
    const next = h.timers.pending('timeout');
    expect(next[0]?.delay).toBe(1000); // backoff reset, not doubled
  });

  it('malformed status frames are ignored (no state change, no backoff reset)', () => {
    const h = createHarness();
    h.sources[0]?.emitRaw('<not json>');
    expect(h.states).toEqual([]);
    expect(h.statuses).toHaveLength(0);
    // Backoff un-reset: after an error the first reconnect is still 1s here,
    // so force two cycles and verify doubling is unaffected.
    h.sources[0]?.emitError();
    const first = h.timers.pending('timeout')[0];
    h.timers.fireTimeout(first?.id ?? 0);
    h.sources[1]?.emitError();
    expect(h.timers.pending('timeout')[0]?.delay).toBe(2000);
  });

  it('wrong-shape JSON frames are ignored without backoff reset', () => {
    const h = createHarness();
    h.sources[0]?.emitRaw(JSON.stringify({ error: 'internal-error', message: 'boom' }));
    h.sources[0]?.emitRaw(JSON.stringify({ ...makeStatus(), status: 'bogus' }));
    h.sources[0]?.emitRaw(JSON.stringify({ status: 'active' }));
    expect(h.states).toEqual([]);
    expect(h.statuses).toHaveLength(0);
    h.sources[0]?.emitError();
    const first = h.timers.pending('timeout')[0];
    h.timers.fireTimeout(first?.id ?? 0);
    h.sources[1]?.emitError();
    expect(h.timers.pending('timeout')[0]?.delay).toBe(2000);
  });

  it('stop() closes the live source, clears poll + reconnect timers, mutes callbacks', () => {
    const h = createHarness();
    h.sources[0]?.emitError(); // polling + reconnect scheduled
    h.controller.stop();
    expect(h.sources[0]?.closed).toBe(true);
    expect(h.timers.pending('interval')).toHaveLength(0);
    expect(h.timers.pending('timeout')).toHaveLength(0);
    const framesBefore = h.statuses.length;
    h.sources[0]?.emitStatus(makeStatus());
    expect(h.statuses.length).toBe(framesBefore); // no callbacks after stop
  });
});

describe('clockOffsetFrom', () => {
  it('returns nowMs - parsed serverTime', () => {
    const t = Date.parse('2026-01-01T00:00:00.000Z');
    expect(clockOffsetFrom('2026-01-01T00:00:00.000Z', t + 5000)).toBe(5000);
    expect(clockOffsetFrom('2026-01-01T00:00:05.000Z', t)).toBe(-5000);
  });

  it('returns null for unparseable serverTime (caller keeps previous offset)', () => {
    expect(clockOffsetFrom('not-a-time', NOW)).toBe(null);
  });
});
