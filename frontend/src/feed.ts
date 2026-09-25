/**
 * FeedController: the SSE-primary / poll-fallback state machine extracted
 * from App.tsx so backoff, reconnect, poll fallback, and teardown are
 * testable without a DOM. The EventSource constructor, the status fetch,
 * clock reads, and all timers are injected; the component stays
 * presentation-only.
 *
 * Semantics preserved verbatim from the original effect:
 * - one initial fetch, then EventSource connect on `url`
 * - a `status` frame clears load error, updates the clock offset, resets
 *   backoff to 1s, stops poll fallback, and reports `live-sse`
 * - connection failure closes the source, reports `polling`, starts a 5s
 *   poll interval, and schedules a reconnect with doubling backoff (1s ->
 *   10s cap); a successful status frame resets the backoff
 * - stop() closes the live source and clears both timers; no callback
 *   fires afterwards
 */
import type { StatusPayload } from './api';

export type FeedState = 'connecting' | 'live-sse' | 'polling';

export interface FeedEventSource {
  addEventListener(type: 'status', listener: (ev: { data: unknown }) => void): void;
  onError(listener: () => void): void;
  close(): void;
}

type TimerId = number;

export interface FeedTimers {
  setTimeout(handler: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  setInterval(handler: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
}

export interface FeedDeps extends FeedTimers {
  url: string;
  makeEventSource(url: string): FeedEventSource;
  fetchStatus(): Promise<StatusPayload>;
  now(): number;
  onState(state: FeedState): void;
  onStatus(status: StatusPayload, clockOffsetMs: number | null): void;
  onLoadError(message: string): void;
}

export interface FeedController {
  stop(): void;
}

export const MAX_BACKOFF_MS = 10000;
export const POLL_FALLBACK_MS = 5000;

/**
 * Offset so that serverNow = nowMs - clockOffsetMs. Null when serverTime is
 * unparseable; callers keep their previous offset in that case.
 */
export function clockOffsetFrom(serverTimeIso: string, nowMs: number): number | null {
  const parsed = Date.parse(serverTimeIso);
  if (Number.isNaN(parsed)) return null;
  return nowMs - parsed;
}

export function createFeedController(deps: FeedDeps): FeedController {
  let stopped = false;
  let es: FeedEventSource | null = null;
  let backoff = 1000;
  let pollTimer: TimerId | undefined;
  let reconnectTimer: TimerId | undefined;

  function setState(state: FeedState): void {
    if (!stopped) deps.onState(state);
  }

  function applyStatus(s: StatusPayload): void {
    if (stopped) return;
    deps.onStatus(s, clockOffsetFrom(s.serverTime, deps.now()));
  }

  function stopPollFallback(): void {
    if (pollTimer === undefined) return;
    deps.clearInterval(pollTimer);
    pollTimer = undefined;
  }

  async function pollOnce(): Promise<void> {
    try {
      applyStatus(await deps.fetchStatus());
    } catch {
      // Poll failures are silent; the next 5s tick retries.
    }
  }

  function startPollFallback(): void {
    if (pollTimer !== undefined) return;
    setState('polling');
    pollTimer = deps.setInterval(() => {
      void pollOnce();
    }, POLL_FALLBACK_MS);
  }

  function scheduleReconnect(connect: () => void): void {
    if (stopped || reconnectTimer !== undefined) return;
    const delay = Math.min(backoff, MAX_BACKOFF_MS);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function connect(): void {
    if (stopped) return;
    let source: FeedEventSource;
    try {
      source = deps.makeEventSource(deps.url);
    } catch {
      startPollFallback();
      scheduleReconnect(connect);
      return;
    }
    es = source;
    source.addEventListener('status', (ev) => {
      try {
        applyStatus(JSON.parse(String(ev.data)) as StatusPayload);
      } catch {
        // Malformed frame: ignore it, keep waiting for the next one.
        return;
      }
      backoff = 1000;
      stopPollFallback();
      setState('live-sse');
    });
    source.onError((): void => {
      try {
        source.close();
      } catch {
        // close() is best-effort; reconnect proceeds regardless.
      }
      if (es === source) es = null;
      if (stopped) return;
      startPollFallback();
      scheduleReconnect(connect);
    });
  }

  void deps.fetchStatus().then(
    (s) => applyStatus(s),
    (err: unknown) => {
      if (!stopped) {
        deps.onLoadError(err instanceof Error ? err.message : 'status load failed');
      }
    },
  );
  connect();

  function stop(): void {
    stopped = true;
    try {
      es?.close();
    } catch {
      // Best-effort teardown.
    }
    if (pollTimer !== undefined) {
      deps.clearInterval(pollTimer);
      pollTimer = undefined;
    }
    if (reconnectTimer !== undefined) {
      deps.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  return { stop };
}
