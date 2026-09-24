import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { Application } from '../../Application.js';
import { envelope } from '../../models/responses/envelope.js';
import { registerSaleRoutes } from './handlers/api/sale/index.js';
import { registerPurchaseRoutes } from './handlers/api/purchase/index.js';

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

export async function buildHttpServer(application: Application): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.setValidatorCompiler(({ schema }) => {
    return (data: unknown) => {
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

  await Promise.all([
    app.register(cors, { origin: true }),
    app.register(rateLimit, {
      global: false,
      errorResponseBuilder: (_req: FastifyRequest, context: { after: string }) =>
        Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
          statusCode: 429,
          rateLimited: true,
        }),
    }),
  ]);

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

  registerSaleRoutes(app, application);
  registerPurchaseRoutes(app, application);

  return app;
}

export async function startHttp(application: Application): Promise<FastifyInstance> {
  const fastify = await buildHttpServer(application);
  await fastify.listen({ host: '0.0.0.0', port: application.config.port });
  application.logger.info(
    `[boot] listening on 0.0.0.0:${String(application.config.port)} ` +
    `sale=${application.config.saleStart}..${application.config.saleEnd}`,
  );
  return fastify;
}
