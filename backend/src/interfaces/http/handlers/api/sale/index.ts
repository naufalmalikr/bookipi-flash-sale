import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Application } from '../../../../../Application.js';
import { envelope } from '../../../../../models/responses/envelope.js';
import type { SaleStatusResponse } from '../../../../../models/responses/sale.response.js';

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
}

function createSseHub(): SseHub {
  return {
    clients: new Set<ServerResponse>(),
    tickTimer: undefined,
    heartbeatTimer: undefined,
    unsubscribePurchase: undefined,
    lastStatus: undefined,
  };
}

async function tickAndFanOut(
  hub: SseHub,
  application: Application,
  logInfo: (msg: string) => void,
): Promise<void> {
  if (hub.clients.size === 0) return;
  let payload: SaleStatusResponse;
  try {
    payload = await application.saleService.buildStatusPayload();
  } catch {
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
    } catch {
    }
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

  fastify.get('/api/sale/status', (_req, reply) => {
    void (async () => {
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
    })();
  });

  fastify.get('/api/sale/events', (req, reply) => {
    void (async () => {
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
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      hub.lastStatus = initial.status;
      raw.write(formatStatus(initial));
      hub.clients.add(raw);
      ensureTimers(hub, application, logInfo);
      req.raw.on('close', () => {
        hub.clients.delete(raw);
        maybeStopTimers(hub);
      });
    })();
  });
}
