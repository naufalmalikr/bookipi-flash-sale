import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Application } from '../../Application.ts';
import { envelope } from '../../models/responses/envelope.ts';
import { registerSaleRoutes } from './handlers/api/sale/index.ts';
import { registerPurchaseRoutes } from './handlers/api/purchase/index.ts';

/** Branded error thrown by our Zod validator compiler. Matched with
 * `instanceof` in the error handler — never by message string, so it
 * survives Fastify upgrades that reword internal messages. Fastify's
 * `wrapValidationError` passes `Error` instances through untouched
 * (only stamping `statusCode`/`code`), so the brand arrives intact. */
export class ZodValidationError extends Error {
  readonly validation: unknown;
  constructor(validation: unknown) {
    super('validation');
    this.name = 'ZodValidationError';
    this.validation = validation;
  }
}

function isZodValidationError(err: unknown): err is ZodValidationError {
  return err instanceof ZodValidationError;
}

export async function buildHttpServer(application: Application): Promise<FastifyInstance> {
  // trustProxy: behind a load balancer the client IP arrives via
  // `X-Forwarded-For`. Without this, `request.ip` is the proxy's IP and the
  // buy rate limiter measures the LB, not the buyer — the same single-IP
  // class of problem as the k6 single-NAT note (solved there with
  // `RATE_LIMIT_BUY=0`). The explicit `keyGenerator` below pins the limit
  // key to that proxy-aware IP.
  const fastify = Fastify({ logger: true, trustProxy: true });

  fastify.setValidatorCompiler(({ schema }) => {
    return (data: unknown) => {
      const zodSchema = schema as z.ZodType;
      const parsed = zodSchema.safeParse(data);
      if (parsed.success) {
        return { value: parsed.data };
      }
      return { error: new ZodValidationError(parsed.error.issues) };
    };
  });

  await Promise.all([
    fastify.register(cors, { origin: true }),
    fastify.register(rateLimit, {
      global: false,
      keyGenerator: (req) => req.ip,
      errorResponseBuilder: (_req: FastifyRequest, context: { after: string }) =>
        Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
          statusCode: 429,
          rateLimited: true,
        }),
    }),
  ]);

  fastify.setErrorHandler((err: FastifyError, _req, reply) => {
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

  fastify.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send(envelope('not-found', 'Route not found'));
  });

  fastify.get('/health', () => ({ ok: true }));

  registerSaleRoutes(fastify, application);
  registerPurchaseRoutes(fastify, application);

  return fastify;
}

export async function startHttp(application: Application): Promise<FastifyInstance> {
  const fastify = await buildHttpServer(application);
  await fastify.listen({ host: '0.0.0.0', port: application.config.port });
  application.logger.info(
    `[boot] listening on 0.0.0.0:${String(application.config.port)} sale=${application.config.saleStart}..${application.config.saleEnd}`,
  );
  let closing = false;
  async function shutdown(signal: string): Promise<void> {
    if (closing) return;
    closing = true;
    application.logger.info(`[shutdown] ${signal} received, draining`);
    try {
      await fastify.close();
    } catch (err) {
      application.logger.error('[shutdown] fastify.close failed', err);
    }
    try {
      await application.database.close();
    } catch (err) {
      application.logger.error('[shutdown] pool.end failed', err);
    }
    process.exit(0);
  }
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
  return fastify;
}
