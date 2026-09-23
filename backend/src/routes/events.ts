/**
 * SSE broadcaster (Todo 9): GET /api/sale/events as text/event-stream.
 *
 * - `event: status` JSON pushed on every purchase commit (via
 *   onPurchaseCommitted from routes/purchase.ts), on window transition, and
 *   on a 2s tick. The tick computes ONE status payload (single direct COUNT,
 *   bypassing StockCache for freshness) and fans it out to ALL connected
 *   clients — one COUNT serves N clients, never N COUNTs.
 * - Window transitions are covered by the tick itself: every tick re-sends
 *   the full payload, so a status flip (upcoming->active->ended) reaches
 *   clients within one tick. `lastStatus` is tracked to observe/log the flip.
 * - `:heartbeat` SSE comment every 15s keeps intermediaries from idling out.
 * - In-memory clients set (single instance, no Redis pub/sub, no WS upgrade).
 * - Global timers start on the first client and stop when the last client
 *   leaves; per-client cleanup via req.raw.on('close') (unsubscribe + timer
 *   teardown when zero clients remain).
 * - No rate-limit on this route (buy-only limiting lives on POST /api/purchase).
 */

import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import { pool } from '../db/pool.js';
import { computeSaleState, type SaleStatus } from '../services/sale.js';
import { onPurchaseCommitted } from './purchase.js';

const TICK_MS = 2000;
const HEARTBEAT_MS = 15000;

export interface StatusPayload {
  status: SaleStatus;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

/**
 * Shared status builder for the SSE path (tick + purchase-commit push).
 * Authoritative sale_config read + ONE direct COUNT (fresh — deliberately
 * bypasses StockCache so commit pushes never serve a stale cached count).
 * The cached GET /api/sale/status route behavior is unchanged.
 */
export async function buildStatusPayload(nowMs: number = Date.now()): Promise<StatusPayload> {
  const cfg = await pool.query<{
    stock_qty: number;
    starts_at: Date;
    ends_at: Date;
  }>(
    `SELECT stock_qty, starts_at, ends_at
       FROM sale_config WHERE id = 1`,
  );
  const row = cfg.rows[0];
  if (row === undefined) throw new Error('sale-not-configured');
  const { status } = computeSaleState(
    row.starts_at.getTime(),
    row.ends_at.getTime(),
    nowMs,
  );
  const counted = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM stock_units
      WHERE sale_id = 1 AND status = 'available'`,
  );
  return {
    status,
    stockRemaining: Number.parseInt(counted.rows[0]?.n ?? '0', 10),
    totalStock: row.stock_qty,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    serverTime: new Date(nowMs).toISOString(),
  };
}

function formatStatus(payload: StatusPayload): string {
  return `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Connected SSE sinks. Module-global = single instance in-memory fan-out. */
const clients = new Set<ServerResponse>();

let tickTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribePurchase: (() => void) | undefined;
/** Last broadcast status; observed so window flips are visible in logs. */
let lastStatus: SaleStatus | undefined;

/** Compute ONE payload, fan out to every connected client. */
async function tickAndFanOut(logInfo: (msg: string) => void): Promise<void> {
  if (clients.size === 0) return;
  let payload: StatusPayload;
  try {
    payload = await buildStatusPayload();
  } catch {
    // A failed tick must never kill the stream; next tick retries.
    return;
  }
  if (lastStatus !== undefined && payload.status !== lastStatus) {
    logInfo(`[sse] window transition ${lastStatus} -> ${payload.status}`);
  }
  lastStatus = payload.status;
  const frame = formatStatus(payload);
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      // Write failures surface via 'close'; the cleanup handler drops them.
    }
  }
}

function ensureTimers(logInfo: (msg: string) => void): void {
  if (tickTimer !== undefined) return;
  // Fresh-status push on every purchase commit (one COUNT, fan out to all).
  unsubscribePurchase = onPurchaseCommitted(() => {
    void tickAndFanOut(logInfo);
  });
  tickTimer = setInterval(() => {
    void tickAndFanOut(logInfo);
  }, TICK_MS);
  tickTimer.unref();
  heartbeatTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(':heartbeat\n\n');
      } catch {
        // Same as above: 'close' handler reaps dead sinks.
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

function maybeStopTimers(): void {
  if (clients.size > 0) return;
  if (tickTimer !== undefined) {
    clearInterval(tickTimer);
    tickTimer = undefined;
  }
  if (heartbeatTimer !== undefined) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (unsubscribePurchase !== undefined) {
    unsubscribePurchase();
    unsubscribePurchase = undefined;
  }
  lastStatus = undefined;
}

export async function registerEventsRoute(app: FastifyInstance): Promise<void> {
  app.get('/api/sale/events', (req, reply) => {
    void (async () => {
      const logInfo = (msg: string): void => {
        req.log.info(msg);
      };
      // Initial payload is built BEFORE headers: a DB failure on connect
      // must 500 (so the client can react) instead of an empty 200 stream.
      let initial: StatusPayload;
      try {
        initial = await buildStatusPayload();
      } catch {
        void reply.code(500).send({
          error: 'internal-error',
          message: 'Failed to load sale status',
        });
        return;
      }
      reply.hijack();
      const raw: ServerResponse = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      lastStatus = initial.status;
      raw.write(formatStatus(initial));
      clients.add(raw);
      ensureTimers(logInfo);
      req.raw.on('close', () => {
        clients.delete(raw);
        maybeStopTimers();
      });
    })();
  });
}
