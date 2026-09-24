import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildHttpServer } from './index.js';
import type { Application } from '../../Application.js';
import { SaleServiceImpl } from '../../services/sale/index.js';
import { PurchaseServiceImpl, canonicalizeUserId } from '../../services/purchase/index.js';
import type { Cache } from '../../entities/Cache.js';
import type { Database } from '../../entities/Database.js';
import type { Logger } from '../../entities/Logger.js';

function stubDb(): Database {
  const noDb = (): never => {
    throw new Error('no-db');
  };
  return {
    getSaleConfig: noDb,
    countAvailable: noDb,
    getCounts: noDb,
    findPurchaseByCanonical: noDb,
    hasPriorPurchase: noDb,
    claimPurchase: noDb,
    getSaleWindow: noDb,
    ensureSchema: noDb,
    upsertSaleConfig: noDb,
    convergeUnits: noDb,
    close: async (): Promise<void> => {},
  };
}

function testApplication(): Application {
  const db = stubDb();
  const cache: Cache = {
    getStatus: (): undefined => undefined,
    setStatus: (): void => {},
    invalidate: (): void => {},
  };
  const logger: Logger = {
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    debug: (): void => {},
  };
  const now = Date.now();
  return {
    config: {
      port: 0,
      databaseUrl: '',
      saleStart: new Date(now + 60_000).toISOString(),
      saleEnd: new Date(now + 600_000).toISOString(),
      stockQty: 5,
      saleProduct: 'Test Widget',
      rateLimitBuy: 10,
      poolMax: 1,
    },
    saleService: new SaleServiceImpl(db, cache, logger),
    purchaseService: new PurchaseServiceImpl(db, cache, logger),
    database: db,
    cache,
    logger,
  } as unknown as Application;
}

const stubCache: Cache = { getStatus: () => undefined, setStatus: () => {}, invalidate: () => {} };
const stubLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const svc = new SaleServiceImpl(stubDb(), stubCache, stubLogger);

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe('error envelope via app.inject (no DB, no listen)', () => {
  it('unknown route -> 404 not-found envelope', async () => {
    app = await buildHttpServer(testApplication());
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('not-found');
    expect(typeof body.message).toBe('string');
  });

  it('GET /health stays 200 (envelope paths do not break happy paths)', async () => {
    app = await buildHttpServer(testApplication());
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('malformed JSON POST -> 400 bad-request envelope (never 500)', async () => {
    app = await buildHttpServer(testApplication());
    const res = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('bad-request');
    expect(typeof body.message).toBe('string');
  });

  it('invalid purchase body -> 400 invalid-userId envelope (Zod fails pre-handler, no DB hit)', async () => {
    app = await buildHttpServer(testApplication());
    for (const payload of [
      { userId: 'not-an-email' },
      { userId: '' },
      { userId: 123 },
      {},
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/purchase',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string; message: string };
      expect(body.error).toBe('invalid-userId');
      expect(typeof body.message).toBe('string');
    }
  });

  it('invalid GET /api/purchase/:userId param -> 400 invalid-userId envelope (no DB hit)', async () => {
    app = await buildHttpServer(testApplication());
    const res = await app.inject({
      method: 'GET',
      url: '/api/purchase/not-an-email',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('invalid-userId');
  });

  it('wrong-method on purchase route -> 404 not-found envelope', async () => {
    app = await buildHttpServer(testApplication());
    const res = await app.inject({ method: 'DELETE', url: '/api/purchase' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not-found');
  });
});

describe('error-code mapping table (pure-unit, DB paths owned by integration-test)', () => {
  it('403 sale-not-active trigger: computeSaleState gates before any transaction', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const end = start + 10 * 60 * 1000;
    expect(svc.computeSaleState(start, end, start - 60_000).status).toBe('upcoming');
    expect(svc.computeSaleState(start, end, end + 60_000).status).toBe('ended');
    expect(svc.computeSaleState(start, end, start).status).toBe('active');
  });

  it('400 invalid-userId trigger: canonicalizeUserId throws on Zod-passing-but-bad edge input', () => {
    expect(() => canonicalizeUserId('   ')).toThrowError('invalid-userId');
    expect(() => canonicalizeUserId('foo@@gmail.com')).toThrowError('invalid-userId');
  });

  it('409 already-purchased trigger pair: Gmail variants collapse to one canonical id', () => {
    expect(canonicalizeUserId('Foo.Bar+baz@GoogleMail.com')).toBe(
      canonicalizeUserId('foobar@gmail.com'),
    );
  });

  it('409 vs 404 distinction on GET /api/purchase/:userId is canonical-id based', () => {
    expect(canonicalizeUserId('f.o.o@gmail.com')).toBe('foo@gmail.com');
  });
});
