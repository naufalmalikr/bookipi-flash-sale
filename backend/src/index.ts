/**
 * Backend skeleton (Todo 4): strict Fastify v5 + Zod plumbing.
 *
 * - setValidatorCompiler Zod adapter returning {value}/{error}, NEVER throws.
 * - @fastify/cors open; @fastify/rate-limit global:false, per-route ONLY on
 *   POST /api/purchase (status/events/health/purchase-:userId unlimited).
 * - GET /health -> {ok:true}; GET /api/sale/status live (Todo 8, cached
 *   stockRemaining); remaining stubs -> 501 not-implemented (Todos 6-7,9);
 *   POST /api/purchase validates {userId: email} -> invalid body 400
 *   invalid-userId, valid body -> 501 (proves Zod works).
 * - Uniform JSON error envelope {error, message}: 404 via setNotFoundHandler,
 *   malformed JSON -> 400 (never 500).
 * - Boot: validate env (UTC Z-only, 500-at-boot + exit(1) on violation),
 *   run schema.sql then seed logic (sale_config upsert + unit top-up),
 *   listen 0.0.0.0:PORT.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { loadBootEnv } from './env.js';
import { pool } from './db/pool.js';
import { computeSaleState } from './services/sale.js';
import { stockCache } from './cache/stockCache.js';
import { registerPurchaseRoute } from './routes/purchase.js';
import { registerEventsRoute } from './routes/events.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist layout mirrors src, so a co-located dist/db/schema.sql wins when the
// build copies static assets; otherwise fall back to the src tree (the
// Dockerfile COPYs backend/ wholesale, so src always ships next to dist).
const SCHEMA_CANDIDATES = [
  join(here, 'db', 'schema.sql'),
  join(here, '..', 'src', 'db', 'schema.sql'),
];

async function loadSchemaSql(): Promise<string> {
  let lastErr: unknown = null;
  for (const p of SCHEMA_CANDIDATES) {
    try {
      return await readFile(p, 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('schema.sql not found');
}

interface ErrorEnvelope {
  error: string;
  message: string;
}

function envelope(error: string, message: string): ErrorEnvelope {
  return { error, message };
}

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

export async function buildApp(rateLimitBuy: number) {
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

  // --- Stubs (Todos 6-9 implement; 501 proves routing + envelope) ---
  app.get('/api/sale/status', (_req, reply) => {
    void (async () => {
      try {
        const cfg = await pool.query<{
          product_name: string;
          stock_qty: number;
          starts_at: Date;
          ends_at: Date;
        }>(
          `SELECT product_name, stock_qty, starts_at, ends_at
           FROM sale_config WHERE id = 1`,
        );
        const row = cfg.rows[0];
        if (row === undefined) {
          void reply
            .code(500)
            .send(envelope('internal-error', 'Sale is not configured'));
          return;
        }
        const nowMs = Date.now();
        const startsAt = row.starts_at.toISOString();
        const endsAt = row.ends_at.toISOString();
        const serverTime = new Date(nowMs).toISOString();
        const { status } = computeSaleState(
          row.starts_at.getTime(),
          row.ends_at.getTime(),
          nowMs,
        );
        const totalStock = row.stock_qty;

        const hit = stockCache.getStatus();
        let stockRemaining: number;
        if (hit !== undefined && hit.value.totalStock === totalStock) {
          stockRemaining = hit.value.stockRemaining;
        } else {
          console.log('[status] cache miss: COUNT stock_units');
          const counted = await pool.query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM stock_units
             WHERE sale_id = 1 AND status = 'available'`,
          );
          stockRemaining = Number.parseInt(counted.rows[0]?.n ?? '0', 10);
          stockCache.setStatus({ stockRemaining, totalStock });
        }

        void reply.code(200).send({
          status,
          stockRemaining,
          totalStock,
          startsAt,
          endsAt,
          serverTime,
        });
      } catch {
        void reply
          .code(500)
          .send(envelope('internal-error', 'Failed to load sale status'));
      }
    })();
  });

  await registerEventsRoute(app);

  await registerPurchaseRoute(app, rateLimitBuy);

  return app;
}

/** Apply schema.sql then run seed logic (sale_config upsert + unit top-up). */
async function migrateAndSeed(saleStart: string, saleEnd: string): Promise<void> {
  const schemaSql = await loadSchemaSql();
  await pool.query(schemaSql);
  const stockQtyRaw: string | undefined = process.env['STOCK_QTY'];
  let stockQty = 100;
  if (stockQtyRaw !== undefined && stockQtyRaw !== '') {
    const parsed = Number.parseInt(stockQtyRaw, 10);
    if (Number.isInteger(parsed) && parsed > 0) stockQty = parsed;
  }
  const product: string = process.env['SALE_PRODUCT'] ?? 'Bookipi Flash Widget';

  const upsert = await pool.query<{ id: number; stock_qty: number }>(
    `INSERT INTO sale_config (id, product_name, stock_qty, starts_at, ends_at)
     VALUES (1, $1, $2, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       stock_qty = EXCLUDED.stock_qty,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at
     RETURNING id, stock_qty`,
    [product, stockQty, saleStart, saleEnd],
  );
  const topped = await pool.query<{ id: number }>(
    `INSERT INTO stock_units (sale_id, status)
     SELECT 1, 'available'
     FROM generate_series(
       1,
       GREATEST($1 - (SELECT COUNT(*)::int FROM stock_units WHERE sale_id = 1), 0)
     ) AS g
     RETURNING id`,
    [stockQty],
  );
  const row = upsert.rows[0];
  console.log(
    `[boot] sale_config id=${String(row?.id)} stock_qty=${String(row?.stock_qty)} units_inserted=${String(topped.rowCount)}`,
  );
}

async function main(): Promise<void> {
  const env = loadBootEnv();
  const app = await buildApp(env.rateLimitBuy);
  try {
    await migrateAndSeed(env.saleStart, env.saleEnd);
  } catch (err) {
    console.error(`[boot] 500 database init failed: ${(err as Error).message}`);
    process.exit(1);
  }
  await app.listen({ host: '0.0.0.0', port: env.port });
  console.log(
    `[boot] listening on 0.0.0.0:${String(env.port)} sale=${env.saleStart}..${env.saleEnd}`,
  );
}

const invokedAsMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  await main();
}
