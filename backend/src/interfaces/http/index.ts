/**
 * HTTP interface adapter (thin): Fastify v5 plumbing + route wiring.
 *
 * ZERO business logic — every handler delegates 100% to the injected
 * Application (saleService / purchaseService). No SQL, no
 * canonicalization, no window math, no process.env in this file.
 *
 * Plumbing is copied verbatim from the legacy boot (backend/src/index.ts):
 * - setValidatorCompiler Zod adapter returning {value}/{error}, NEVER throws.
 * - @fastify/cors open; @fastify/rate-limit global:false, per-route ONLY on
 *   POST /api/purchase (status/events/health/purchase-:userId unlimited).
 * - Uniform JSON error envelope {error, message}: 404 via
 *   setNotFoundHandler, malformed JSON -> 400 (never 500).
 * - GET /health -> {ok:true}.
 * - GET /api/sale/events as text/event-stream: initial payload built BEFORE
 *   headers (-> 500 on DB failure), hijack, 2s tick (ONE payload fans all),
 *   15s heartbeat, purchase-commit subscription via
 *   purchaseService.onCommitted, timers start on first client / stop on last,
 *   per-client cleanup via req.raw close.
 */

import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Application } from '../../Application.js';
import { envelope } from '../../models/responses/envelope.js';
import { purchaseBodySchema } from '../../models/requests/purchase.request.js';

/** Shape marker attached by the Zod validator compiler (never thrown). */
interface ZodValidationMarker {
  validation: unknown;
}

function isZodValidationError(err: unknown): err is Error & ZodValidationMarker {
  if (typeof err !== 'object' || err === null) return false;
  return (
    'message' in err &&
    (err as { message?: unknown }).message === 'validation' &&
    'validation' in err
  );
}

interface StatusPayload {
  status: string;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

function formatStatus(payload: StatusPayload): string {
  return `event: status\ndata: ${JSON.stringify(payload)}\n\n`;
}

const TICK_MS = 2000;
const HEARTBEAT_MS = 15000;

/** Connected SSE sinks. Module-global = single instance in-memory fan-out. */
const clients = new Set<ServerResponse>();

let tickTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let unsubscribePurchase: (() => void) | undefined;
/** Last broadcast status; observed so window flips are visible in logs. */
let lastStatus: string | undefined;

/** Compute ONE payload, fan out to every connected client. */
async function tickAndFanOut(
  application: Application,
  logInfo: (msg: string) => void,
): Promise<void> {
  if (clients.size === 0) return;
  let payload: StatusPayload;
  try {
    payload = await application.saleService.buildStatusPayload();
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

function ensureTimers(
  application: Application,
  logInfo: (msg: string) => void,
): void {
  if (tickTimer !== undefined) return;
  // Fresh-status push on every purchase commit (one payload, fan out to all).
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

/** Build a Fastify instance wired 100% to the injected Application. */
export async function buildApp(application: Application): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Zod adapter: return {value} on success, {error} on failure — NEVER throw.
  app.setValidatorCompiler(({ schema }) => {
    return (data: unknown) => {
      // Route schemas are Zod schemas (see purchase body below).
      const zodSchema = schema as z.ZodType;
      const parsed = zodSchema.safeParse(data);
      if (parsed.success) {
        return { value: parsed.data };
      }
      return {
        error: Object.assign(new Error('validation'), {
          validation: parsed.error.issues,
        }),
      };
    };
  });

  await app.register(cors, { origin: true });

  // Globally disabled; enabled per-route ONLY on POST /api/purchase.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_req: FastifyRequest, context: { after: string }) =>
      Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
        statusCode: 429,
        rateLimited: true,
      }),
  });

  // Uniform error envelope. Validation -> 400 invalid-userId;
  // malformed JSON (SyntaxError / FST_ERR_CTP_*) -> 400 (never 500);
  // rate-limit (429 marker) -> 429 rate-limited.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    if (isZodValidationError(err)) {
      void reply
        .code(400)
        .send(envelope('invalid-userId', 'Body must be { userId: <email> }'));
      return;
    }
    const code: string | undefined = err.code;
    if (
      err instanceof SyntaxError ||
      (code !== undefined && code.startsWith('FST_ERR_CTP_')) ||
      code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
      code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' ||
      code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      err.statusCode === 400
    ) {
      void reply.code(400).send(envelope('bad-request', 'Malformed JSON body'));
      return;
    }
    if (err.statusCode === 429 || (err as { rateLimited?: unknown }).rateLimited === true) {
      void reply
        .code(429)
        .send(envelope('rate-limited', 'Rate limit exceeded, slow down'));
      return;
    }
    const status = err.statusCode !== undefined && err.statusCode >= 400 ? err.statusCode : 500;
    // Align every fallback body to the canonical code set:
    // 404 -> not-found, other 4xx -> bad-request, 5xx -> internal-error.
    if (status === 404) {
      void reply.code(404).send(envelope('not-found', err.message ?? 'Route not found'));
      return;
    }
    if (status >= 400 && status < 500) {
      void reply.code(status).send(envelope('bad-request', err.message ?? 'Bad request'));
      return;
    }
    void reply.code(500).send(envelope('internal-error', 'Internal server error'));
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(envelope('not-found', 'Route not found'));
  });

  app.get('/health', () => ({ ok: true }));

  app.get('/api/sale/status', (_req, reply) => {
    void (async () => {
      try {
        const payload: StatusPayload = await application.saleService.getStatus();
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

  app.get('/api/sale/events', (req, reply) => {
    void (async () => {
      const logInfo = (msg: string): void => {
        req.log.info(msg);
      };
      // Initial payload is built BEFORE headers: a DB failure on connect
      // must 500 (so the client can react) instead of an empty 200 stream.
      let initial: StatusPayload;
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

  app.get('/api/purchase/:userId', (req, reply) => {
    void (async () => {
      const rawUserId = (req.params as { userId: string }).userId;
      try {
        const result: { found?: boolean; unitId?: number; error?: string } =
          await application.purchaseService.getPurchaseByUser(rawUserId);
        if (result.error === 'invalid-userId') {
          void reply
            .code(400)
            .send(envelope('invalid-userId', 'Param must be a valid email userId'));
          return;
        }
        if (result.found === true) {
          void reply.code(200).send({ result: 'purchased', unitId: result.unitId });
          return;
        }
        if (result.found === false) {
          void reply
            .code(404)
            .send(envelope('not-purchased', 'This user has not purchased'));
          return;
        }
        void reply
          .code(500)
          .send(envelope('internal-error', 'Failed to check purchase'));
      } catch {
        void reply
          .code(500)
          .send(envelope('internal-error', 'Failed to check purchase'));
      }
    })();
  });

  // rateLimitBuy <= 0 DISABLES per-route rate limiting (k6 load switch;
  // single route-options object keeps the claim handler untouched).
  const rateLimitBuy: number = application.config.rateLimitBuy;
  const buyRouteOptions =
    rateLimitBuy > 0
      ? {
          schema: { body: purchaseBodySchema },
          config: { rateLimit: { max: rateLimitBuy, timeWindow: '1 minute' } },
        }
      : { schema: { body: purchaseBodySchema } };

  app.post('/api/purchase', buyRouteOptions, (req, reply) => {
    void (async () => {
      const rawUserId = (req.body as { userId: string }).userId;
      let outcome:
        | { ok: true; unitId: number }
        | { ok: false; error: string };
      try {
        outcome = await application.purchaseService.attemptPurchase(rawUserId);
      } catch {
        void reply
          .code(500)
          .send(envelope('internal-error', 'Purchase failed'));
        return;
      }
      if (outcome.ok) {
        void reply.code(201).send({ result: 'purchased', unitId: outcome.unitId });
        return;
      }
      switch (outcome.error) {
        case 'invalid-userId':
          void reply
            .code(400)
            .send(envelope('invalid-userId', 'Body must be { userId: <email> }'));
          return;
        case 'sale-not-active':
          void reply
            .code(403)
            .send(envelope('sale-not-active', 'Sale is not currently active'));
          return;
        case 'already-purchased':
          void reply
            .code(409)
            .send(envelope('already-purchased', 'This user already purchased'));
          return;
        case 'sold-out':
          void reply
            .code(409)
            .send(envelope('sold-out', 'All units are sold'));
          return;
        default:
          void reply
            .code(500)
            .send(envelope('internal-error', 'Purchase failed'));
          return;
      }
    })();
  });

  return app;
}

/** Build the injected app and listen on 0.0.0.0:config.port. */
export async function startHttp(application: Application): Promise<FastifyInstance> {
  const fastify = await buildApp(application);
  await fastify.listen({ host: '0.0.0.0', port: application.config.port });
  const line =
    `[boot] listening on 0.0.0.0:${String(application.config.port)} ` +
    `sale=${application.config.saleStart}..${application.config.saleEnd}`;
  if (
    application.logger !== undefined &&
    application.logger !== null &&
    typeof application.logger.info === 'function'
  ) {
    application.logger.info(line);
  } else {
    console.log(line);
  }
  return fastify;
}
