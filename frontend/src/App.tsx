import { useEffect, useRef, useState } from 'react';
import {
  getStatus,
  postPurchase,
  getPurchase,
  eventsUrl,
  type StatusPayload,
} from './api';
import { createFeedController, clockOffsetFrom, type FeedState } from './feed';
import { toneFor, formatDelta } from './display';

interface Alert {
  code: string;
  message: string;
  tone: string;
}

export default function App(): React.JSX.Element {
  const [payload, setPayload] = useState<StatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>('connecting');
  const [email, setEmail] = useState('');
  const [buying, setBuying] = useState(false);
  const [alert, setAlert] = useState<Alert | null>(null);
  // Single authoritative "now" per frame: the 1s tick updates this state
  // and the countdown reads it. Date.now() is never called during render,
  // so every derived time in one frame comes from the same instant.
  const [now, setNow] = useState<number>(() => Date.now());
  const clockOffset = useRef(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const controller = createFeedController({
      url: eventsUrl(),
      fetchStatus: getStatus,
      now: () => Date.now(),
      makeEventSource: (url) => {
        const source = new EventSource(url);
        return {
          addEventListener: (type, listener) => {
            source.addEventListener(type, (ev) => listener(ev as unknown as { data: unknown }));
          },
          onError: (listener) => {
            source.onerror = listener;
          },
          close: () => source.close(),
        };
      },
      onState: setFeed,
      onStatus: (s, offsetMs) => {
        setPayload(s);
        setLoadError(null);
        if (offsetMs !== null) clockOffset.current = offsetMs;
      },
      onLoadError: setLoadError,
      setTimeout: (handler, ms) => window.setTimeout(handler, ms),
      clearTimeout: (id) => window.clearTimeout(id),
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (id) => window.clearInterval(id),
    });
    return () => {
      controller.stop();
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
            const offset = clockOffsetFrom(s.serverTime, Date.now());
            if (offset !== null) clockOffset.current = offset;
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

  const serverNow = now - clockOffset.current;
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
