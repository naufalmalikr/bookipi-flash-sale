import { useEffect, useRef, useState } from 'react';
import {
  getStatus,
  postPurchase,
  getPurchase,
  eventsUrl,
  type StatusPayload,
} from './api';
import { toneFor, formatDelta } from './display';

type FeedState = 'connecting' | 'live-sse' | 'polling';

interface Alert {
  code: string;
  message: string;
  tone: string;
}

const MAX_BACKOFF_MS = 10000;
const POLL_FALLBACK_MS = 5000;

export default function App(): React.JSX.Element {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>('connecting');
  const [email, setEmail] = useState('');
  const [buying, setBuying] = useState(false);
  const [alert, setAlert] = useState<Alert | null>(null);
  const [, setNowTick] = useState<number>(Date.now());
  const clockOffset = useRef(0);

  useEffect(() => {
    const t = setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let es: EventSource | null = null;
    let backoff = 1000;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function applyStatus(s: StatusPayload): void {
      if (stopped) return;
      setPayload(s);
      setLoadError(null);
      const parsed = Date.parse(s.serverTime);
      if (!Number.isNaN(parsed)) {
        clockOffset.current = Date.now() - parsed;
      }
    }

    function stopPollFallback(): void {
      if (pollTimer !== undefined) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    }

    async function pollOnce(): Promise<void> {
      try {
        const s = await getStatus();
        applyStatus(s);
      } catch {
        // Poll failures are silent; the next 5s tick retries.
      }
    }

    function startPollFallback(): void {
      if (pollTimer !== undefined) return;
      setFeed('polling');
      pollTimer = setInterval(() => {
        void pollOnce();
      }, POLL_FALLBACK_MS);
    }

    function scheduleReconnect(connect: () => void): void {
      if (stopped || reconnectTimer !== undefined) return;
      const delay = Math.min(backoff, MAX_BACKOFF_MS);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    }

    function connect(): void {
      if (stopped) return;
      let source: EventSource;
      try {
        source = new EventSource(eventsUrl());
      } catch {
        startPollFallback();
        scheduleReconnect(connect);
        return;
      }
      es = source;
      source.addEventListener('status', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data as string) as StatusPayload;
          applyStatus(data);
        } catch {
          return;
        }
        backoff = 1000;
        stopPollFallback();
        if (!stopped) setFeed('live-sse');
      });
      source.onerror = (): void => {
        try {
          source.close();
        } catch {
          // close() is best-effort; reconnect proceeds regardless.
        }
        if (es === source) es = null;
        if (stopped) return;
        startPollFallback();
        scheduleReconnect(connect);
      };
    }

    void (async () => {
      try {
        const s = await getStatus();
        applyStatus(s);
      } catch (err) {
        if (!stopped) {
          setLoadError(err instanceof Error ? err.message : 'status load failed');
        }
      }
    })();
    connect();

    return () => {
      stopped = true;
      try {
        es?.close();
      } catch {
        // Best-effort teardown.
      }
      stopPollFallback();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, []);

  async function onBuy(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const userId = email.trim();
    if (userId === '') {
      setAlert({ code: 'invalid-userId', message: 'Enter an email address', tone: toneFor('invalid-userId') });
      return;
    }
    setBuying(true);
    setAlert(null);
    try {
      const post = await postPurchase(userId);
      if (post.ok) {
        const unitId = post.body.unitId;
        setAlert({
          code: 'purchased',
          message: 'Secured unit #' + String(unitId),
          tone: toneFor('purchased'),
        });
        void (async () => {
          try {
            const confirm = await getPurchase(userId);
            if (confirm.ok && confirm.body.unitId !== unitId) {
              setAlert({
                code: 'purchased',
                message: 'Secured unit #' + String(unitId) + ' (lookup shows #' + String(confirm.body.unitId) + ')',
                tone: toneFor('purchased'),
              });
            }
          } catch {
            // Confirm is advisory; the POST 201 above is the source of truth.
          }
          try {
            const s = await getStatus();
            setPayload(s);
            const parsed = Date.parse(s.serverTime);
            if (!Number.isNaN(parsed)) clockOffset.current = Date.now() - parsed;
          } catch {
            // Status refresh is best-effort; SSE/poll will catch up.
          }
        })();
      } else {
        setAlert({ code: post.error, message: post.message, tone: toneFor(post.error) });
      }
    } catch (err) {
      setAlert({
        code: 'network-error',
        message: err instanceof Error ? err.message : 'request failed',
        tone: toneFor('network-error'),
      });
    } finally {
      setBuying(false);
    }
  }

  const serverNow = Date.now() - clockOffset.current;
  let countdown = '—';
  if (payload !== null) {
    if (payload.status === 'upcoming') {
      countdown = 'starts in ' + formatDelta(Date.parse(payload.startsAt) - serverNow);
    } else if (payload.status === 'active') {
      countdown = 'ends in ' + formatDelta(Date.parse(payload.endsAt) - serverNow);
    } else {
      countdown = 'sale ended';
    }
  }

  return (
    <main className="page">
      <h1>Bookipi Flash Sale</h1>

      <section className="panel" aria-label="sale status">
        <div className="row">
          <span className={'pill pill-' + (payload?.status ?? 'unknown')}>
            {payload?.status ?? 'loading…'}
          </span>
          <span className={'feed feed-' + feed} title="update channel">
            {feed === 'live-sse' ? '● live' : feed === 'polling' ? '● polling fallback' : '● connecting…'}
          </span>
        </div>
        <div className="stock">
          {payload === null ? '—' : String(payload.stockRemaining) + ' / ' + String(payload.totalStock) + ' remaining'}
        </div>
        <div className="countdown">{payload === null ? 'loading status…' : countdown}</div>
        {loadError !== null && <div className="load-error">{loadError}</div>}
        {payload !== null && (
          <div className="times">
            <div>starts: {payload.startsAt}</div>
            <div>ends: {payload.endsAt}</div>
          </div>
        )}
      </section>

      <section className="panel" aria-label="buy form">
        <form onSubmit={(e) => void onBuy(e)}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
          />
          <button type="submit" disabled={buying}>
            {buying ? 'Buying…' : 'Buy Now'}
          </button>
        </form>
        {alert !== null && (
          <div className={'result ' + alert.tone} role="alert">
            <code className="code">[{alert.code}]</code> <span>{alert.message}</span>
          </div>
        )}
      </section>
    </main>
  );
}
