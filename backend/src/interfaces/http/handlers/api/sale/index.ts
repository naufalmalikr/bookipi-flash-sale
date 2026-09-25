import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Application } from '../../../../../Application.ts';
import { envelope } from '../../../../../models/responses/envelope.ts';
import type { SaleStatusResponse } from '../../../../../models/responses/sale.response.ts';

function formatStatus(payload: SaleStatusResponse): string {
  return `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TICK_MS = 2000;
const HEARTBEAT_MS = 15000;

interface SseHub {
  clients: Set<ServerResponse>;
  tickTimer: ReturnType<typeof setInterval> | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  unsubscribePurchase: (() => void) | undefined;
  lastStatus: string | undefined;
  fanOutQueued: boolean;
  fanOutLoggedEmpty: boolean;
  loggedErrorClasses: Set<string>;
}

function createSseHub(): SseHub {
  return {
    clients: new Set<ServerResponse>(),
    tickTimer: undefined,
    heartbeatTimer: undefined,
    unsubscribePurchase: undefined,
    lastStatus: undefined,
    fanOutQueued: false,
    fanOutLoggedEmpty: false,
    loggedErrorClasses: new Set<string>(),
  };
}

function logOnce(hub: SseHub, key: string, logInfo: (msg: string) => void, msg: string): void {
  if (hub.loggedErrorClasses.has(key)) return;
  hub.loggedErrorClasses.add(key);
  logInfo(msg);
}

async function tickAndFanOut(
  hub: SseHub,
  application: Application,
  logInfo: (msg: string) => void,
): Promise<void> {
  if (hub.clients.size === 0) {
    if (!hub.fanOutLoggedEmpty) {
      hub.fanOutLoggedEmpty = true;
      logInfo('[sse] fan-out skipped: no clients');
    }
    return;
  }
  hub.fanOutLoggedEmpty = false;
  if (hub.fanOutQueued) return;
  hub.fanOutQueued = true;
  try {
    let payload: SaleStatusResponse;
    try {
      payload = await application.saleService.buildStatusPayload();
    } catch (err) {
      const key = err instanceof Error ? `status:${err.message}` : 'status:unknown';
      logOnce(hub, key, logInfo, `[sse] buildStatusPayload failed (${key})`);
      return;
    }
    if (hub.lastStatus !== undefined && payload.status !== hub.lastStatus) {
      logInfo(`[sse] window transition ${hub.lastStatus} -> ${payload.status}`);
    }
    hub.lastStatus = payload.status;
    const frame = formatStatus(payload);
    for (const res of hub.clients) {
      try {
        res.write(frame);
      } catch (err) {
        const key = err instanceof Error ? `write:${err.message}` : 'write:unknown';
        logOnce(hub, key, logInfo, `[sse] client write failed (${key})`);
      }
    }
  } finally {
    hub.fanOutQueued = false;
  }
}

function ensureTimers(
  hub: SseHub,
  application: Application,
  logInfo: (msg: string) => void,
): void {
  if (hub.tickTimer !== undefined) return;
  hub.unsubscribePurchase = application.purchaseService.onCommitted(() => {
    void tickAndFanOut(hub, application, logInfo);
  });
  hub.tickTimer = setInterval(() => {
    void tickAndFanOut(hub, application, logInfo);
  }, TICK_MS);
  hub.tickTimer.unref();
  hub.heartbeatTimer = setInterval(() => {
    for (const res of hub.clients) {
      try {
        res.write(':heartbeat\n\n');
      } catch {
      }
    }
  }, HEARTBEAT_MS);
  hub.heartbeatTimer.unref();
}

function maybeStopTimers(hub: SseHub): void {
  if (hub.clients.size > 0) return;
  if (hub.tickTimer !== undefined) {
    clearInterval(hub.tickTimer);
    hub.tickTimer = undefined;
  }
  if (hub.heartbeatTimer !== undefined) {
    clearInterval(hub.heartbeatTimer);
    hub.heartbeatTimer = undefined;
  }
  if (hub.unsubscribePurchase !== undefined) {
    hub.unsubscribePurchase();
    hub.unsubscribePurchase = undefined;
  }
  hub.lastStatus = undefined;
}

export function registerSaleRoutes(fastify: FastifyInstance, application: Application): void {
  // Per-server hub: two apps in one process must not share clients/timers.
  const hub = createSseHub();
  fastify.addHook('onClose', (_instance, done) => {
    hub.clients.clear();
    maybeStopTimers(hub);
    done();
  });
  (fastify as unknown as { sseDrain?: () => void }).sseDrain = () => {
    for (const res of hub.clients) {
      try {
        res.destroy();
      } catch {
      }
    }
    hub.clients.clear();
    maybeStopTimers(hub);
  };

  fastify.get('/api/sale/status', (_req, reply) => {
    (async () => {
      try {
        const payload: SaleStatusResponse = await application.saleService.getStatus();
        void reply.code(200).send(payload);
      } catch (err) {
        if (err instanceof Error && err.message === 'sale-not-configured') {
          void reply
            .code(500)
            .send(envelope('internal-error', 'Sale is not configured'));
          return;
        }
        void reply
          .code(500)
          .send(envelope('internal-error', 'Failed to load sale status'));
      }
    })().catch(() => {});
  });

  fastify.get('/api/sale/events', (req, reply) => {
    (async () => {
      const logInfo = (msg: string): void => {
        req.log.info(msg);
      };
      let initial: SaleStatusResponse;
      try {
        initial = await application.saleService.buildStatusPayload();
      } catch {
        void reply.code(500).send({
          error: 'internal-error',
          message: 'Failed to load sale status',
        });
        return;
      }
      reply.hijack();
      const raw: ServerResponse = reply.raw;
      // reply.hijack() bypasses @fastify/cors, so set the CORS header
      // explicitly — otherwise a strict browser EventSource from the
      // compose frontend (:5173 -> :3001) fails the cross-origin check
      // and silently falls back to polling. Reflect the origin to match
      // the `cors: { origin: true }` policy on non-hijacked routes.
      const origin = req.headers.origin;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin':
          typeof origin === 'string' && origin.length > 0 ? origin : '*',
        Vary: 'Origin',
      });
      hub.lastStatus = initial.status;
      raw.write(formatStatus(initial));
      hub.clients.add(raw);
      ensureTimers(hub, application, logInfo);
      const drop = (): void => {
        hub.clients.delete(raw);
        maybeStopTimers(hub);
      };
      req.raw.on('close', drop);
      // A dead socket never emits 'close' on req.raw promptly; without
      // this the hub keeps writing into a broken pipe on every tick.
      raw.on('error', drop);
    })().catch(() => {});
  });
}
