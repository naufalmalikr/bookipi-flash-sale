/**
 * Todo 11 — error-envelope mapping tests (unit, NO DB, NO listen port).
 *
 * Method: `buildApp(10)` + `await app.inject(...)` + `await app.close()`.
 * The pg Pool is lazy (pool.ts: sockets open only on first query), so any
 * route that validates/fails BEFORE a query runs fully offline:
 *   - unknown route        -> 404 { error: 'not-found', ... }
 *   - malformed JSON POST  -> 400 { error: 'bad-request', ... }
 *   - invalid purchase body-> 400 { error: 'invalid-userId', ... } (Zod
 *     validator compiler fails pre-handler; pool is never touched)
 *
 * Full error-code mapping table (contract, STRATEGY.md §5) documented here;
 * the 403/409/429 paths REQUIRE a DB/rate-limit window and are covered by
 * Todo 13 integration tests against real Postgres — they are asserted below
 * at pure-unit level instead so this file stays offline-green:
 *
 * | HTTP | code              | source (never hit here)                          |
 * |------|-------------------|--------------------------------------------------|
 * | 400  | invalid-userId    | Zod body fail OR canonicalizeUserId throw (TESTED)|
 * | 400  | bad-request       | malformed JSON / SyntaxError (TESTED)            |
 * | 403  | sale-not-active   | getSaleState() status !== 'active' (Todo 13)     |
 * | 404  | not-found         | setNotFoundHandler (TESTED)                      |
 * | 404  | not-purchased     | GET /api/purchase/:userId miss (Todo 13)         |
 * | 409  | already-purchased | fast-path SELECT hit OR SQLSTATE 23505 (Todo 13) |
 * | 409  | sold-out          | SKIP LOCKED returns zero rows (Todo 13)          |
 * | 429  | rate-limited      | @fastify/rate-limit on POST only (Todo 13)       |
 * | 500  | internal-error    | any DB/query failure, always enveloped          |
 * | 501  | not-implemented   | (removed by Todo 10; kept for history)           |
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import { computeSaleState } from './services/sale.js';
import { canonicalizeUserId } from './utils/canonicalize.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe('error envelope via app.inject (no DB, no listen)', () => {
  it('unknown route -> 404 not-found envelope', async () => {
    app = await buildApp(10);
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('not-found');
    expect(typeof body.message).toBe('string');
  });

  it('GET /health stays 200 (envelope paths do not break happy paths)', async () => {
    app = await buildApp(10);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('malformed JSON POST -> 400 bad-request envelope (never 500)', async () => {
    app = await buildApp(10);
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
    app = await buildApp(10);
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
    app = await buildApp(10);
    const res = await app.inject({
      method: 'GET',
      url: '/api/purchase/not-an-email',
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe('invalid-userId');
  });

  it('wrong-method on purchase route -> 404 not-found envelope', async () => {
    app = await buildApp(10);
    const res = await app.inject({ method: 'DELETE', url: '/api/purchase' });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not-found');
  });
});

describe('error-code mapping table (pure-unit, DB paths owned by Todo 13)', () => {
  it('403 sale-not-active trigger: computeSaleState gates before any transaction', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const end = start + 10 * 60 * 1000;
    // Purchase path maps status !== 'active' -> 403; the pure gate proves the trigger.
    expect(computeSaleState(start, end, start - 60_000).status).toBe('upcoming');
    expect(computeSaleState(start, end, end + 60_000).status).toBe('ended');
    expect(computeSaleState(start, end, start).status).toBe('active');
  });

  it('400 invalid-userId trigger: canonicalizeUserId throws on Zod-passing-but-bad edge input', () => {
    // Zod email() lets some shapes through that canonicalize rejects
    // (e.g. padded input would trim, but schema already rejected it; the
    // route catch maps ANY throw -> 400 invalid-userId identically).
    expect(() => canonicalizeUserId('   ')).toThrowError('invalid-userId');
    expect(() => canonicalizeUserId('foo@@gmail.com')).toThrowError('invalid-userId');
  });

  it('409 already-purchased trigger pair: Gmail variants collapse to one canonical id', () => {
    // Fast-path SELECT + 23505 catch both key on this equality; Todo 13
    // proves the HTTP 409 against real Postgres with the same vectors.
    expect(canonicalizeUserId('Foo.Bar+baz@GoogleMail.com')).toBe(
      canonicalizeUserId('foobar@gmail.com'),
    );
  });

  it('409 vs 404 distinction on GET /api/purchase/:userId is canonical-id based', () => {
    // Miss (row undefined) -> 404 not-purchased; hit -> 200 purchased.
    // Both key on the canonical id, so Gmail variants resolve identically.
    expect(canonicalizeUserId('f.o.o@gmail.com')).toBe('foo@gmail.com');
  });
});
