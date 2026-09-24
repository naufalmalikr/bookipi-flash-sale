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

const clients = new Set<ServerResponse>();

let tickTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribePurchase: (() => void) | undefined;
let lastStatus: string | undefined;

async function tickAndFanOut(
  application: Application,
  logInfo: (msg: string) => void,
): Promise<void> {
  if (clients.size === 0) return;
  let payload: SaleStatusResponse;
  try {
    payload = await application.saleService.buildStatusPayload();
  } catch {
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
    }
  }
}

function ensureTimers(
  application: Application,
  logInfo: (msg: string) => void,
): void {
  if (tickTimer !== undefined) return;
  unsubscribePurchase = application.purchaseService.onCommitted(() => {
    void tickAndFanOut(application, logInfo);
  });
  tickTimer = setInterval(() => {
    void tickAndFanOut(application, logInfo);
  }, TICK_MS);
  tickTimer.unref();
  heartbeatTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(':heartbeat\n\n');
      } catch {
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

export function registerSaleRoutes(fastify: FastifyInstance, application: Application): void {
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
      lastStatus = initial.status;
      raw.write(formatStatus(initial));
      clients.add(raw);
      ensureTimers(application, logInfo);
      req.raw.on('close', () => {
        clients.delete(raw);
        maybeStopTimers();
      });
    })();
  });
}
