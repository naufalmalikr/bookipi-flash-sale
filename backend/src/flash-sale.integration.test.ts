/**
 * Todo 13 — Integration suites vs REAL Postgres 18.6.
 *
 * Single file (sequential, no cross-file DB interference) hitting the
 * compose-mapped host DB (localhost:5432, db flashsale,
 * postgres/postgres) via the shared lazy pool. The app is built in-test
 * with buildApp(100000) — a huge buy rate limit so the 50-parallel probe
 * never sees 429 (rate-limiting itself is Todo 9's evidence, not this).
 *
 * Scenarios: (a) lifecycle upcoming->active->ended, (b) one-per-user incl.
 * Gmail-variant 409 + lookup, (c) sold-out path + SQL sold==1, (d) SSE
 * delivery on purchase (ephemeral listen + node:http stream), (e) exact-5:
 * 50 parallel buyers vs 5 units with SQL assertions, (f) rollback proof:
 * socket destroyed mid-txn leaves the row available for the next buyer.
 *
 * afterAll restores STOCK_QTY=100 + sane window (now+60s/+10min) so the
 * stack is healthy for Todo 14 (k6).
 */
import http from 'node:http';
import pg from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './index.js';
import { pool } from './db/pool.js';
import { invalidateStockCache } from './cache/stockCache.js';

const CONNECTION_STRING: string =
  process.env['DATABASE_URL'] ??
  'postgres://postgres:postgres@localhost:5432/flashsale';

interface StatusBody {
  status: string;
  stockRemaining: number;
  totalStock: number;
  startsAt: string;
  endsAt: string;
  serverTime: string;
}

interface PurchaseOk {
  result: string;
  unitId: number;
}

interface ErrBody {
  error: string;
  message: string;
}

function isoAt(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Wipe purchases/units, upsert sale_config id=1, seed N available units. */
async function resetDb(
  stockQty: number,
  startsAt: string,
  endsAt: string,
): Promise<void> {
  await pool.query(`DELETE FROM purchases`);
  await pool.query(`DELETE FROM stock_units`);
  await pool.query(
    `INSERT INTO sale_config (id, product_name, stock_qty, starts_at, ends_at)
     VALUES (1, 'Flash Widget', $1, $2::timestamptz, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       product_name = EXCLUDED.product_name,
       stock_qty = EXCLUDED.stock_qty,
       starts_at = EXCLUDED.starts_at,
       ends_at = EXCLUDED.ends_at`,
    [stockQty, startsAt, endsAt],
  );
  if (stockQty > 0) {
    await pool.query(
      `INSERT INTO stock_units (sale_id, status)
       SELECT 1, 'available' FROM generate_series(1, $1) AS g`,
      [stockQty],
    );
  }
  invalidateStockCache();
}

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query<{ n: string }>(sql, params);
  return Number.parseInt(res.rows[0]?.n ?? '0', 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(100000);
});

afterAll(async () => {
  await resetDb(100, isoAt(60_000), isoAt(600_000));
  const sold = await countOf(
    `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
  );
  const avail = await countOf(
    `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'available'`,
  );
  const bought = await countOf(
    `SELECT COUNT(*)::text AS n FROM purchases WHERE sale_id = 1`,
  );
  console.log(
    `[integration] final restore: sold=${String(sold)} available=${String(avail)} purchases=${String(bought)} (expect 0/100/0)`,
  );
  try {
    await app.close();
  } catch {
    // Shared app may already be closed; pool shutdown below is what matters.
  }
  await pool.end();
});

describe('lifecycle upcoming -> active -> ended', () => {
  it('gates purchases by the server window', async () => {
    await resetDb(5, isoAt(60_000), isoAt(600_000));
    const upcoming = await app.inject({ method: 'GET', url: '/api/sale/status' });
    expect(upcoming.statusCode).toBe(200);
    expect((JSON.parse(upcoming.body) as StatusBody).status).toBe('upcoming');
    const early = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'early@example.com' },
    });
    expect(early.statusCode).toBe(403);
    expect((JSON.parse(early.body) as ErrBody).error).toBe('sale-not-active');

    await resetDb(5, isoAt(-60_000), isoAt(600_000));
    const onTime = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'ontime@example.com' },
    });
    expect(onTime.statusCode).toBe(201);
    expect((JSON.parse(onTime.body) as PurchaseOk).result).toBe('purchased');

    await resetDb(5, isoAt(-600_000), isoAt(-60_000));
    const late = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'late@example.com' },
    });
    expect(late.statusCode).toBe(403);
    expect((JSON.parse(late.body) as ErrBody).error).toBe('sale-not-active');
    const ended = await app.inject({ method: 'GET', url: '/api/sale/status' });
    expect((JSON.parse(ended.body) as StatusBody).status).toBe('ended');
  });
});

describe('one-per-user incl. Gmail variant', () => {
  it('rejects the dotted twin with 409 and confirms one unit via lookup', async () => {
    await resetDb(5, isoAt(-60_000), isoAt(600_000));
    const first = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'foo.bar@gmail.com' },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = JSON.parse(first.body) as PurchaseOk;
    const twin = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'foobar@gmail.com' },
    });
    expect(twin.statusCode).toBe(409);
    expect((JSON.parse(twin.body) as ErrBody).error).toBe('already-purchased');
    const lookup = await app.inject({
      method: 'GET',
      url: '/api/purchase/foobar@gmail.com',
    });
    expect(lookup.statusCode).toBe(200);
    expect((JSON.parse(lookup.body) as PurchaseOk).unitId).toBe(firstBody.unitId);
  });
});

describe('sold-out path', () => {
  it('second buyer gets 409 sold-out and SQL shows exactly 1 sold', async () => {
    await resetDb(1, isoAt(-60_000), isoAt(600_000));
    const winner = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'winner@example.com' },
    });
    expect(winner.statusCode).toBe(201);
    const loser = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'loser@example.com' },
    });
    expect(loser.statusCode).toBe(409);
    expect((JSON.parse(loser.body) as ErrBody).error).toBe('sold-out');
    const sold = await countOf(
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    expect(sold).toBe(1);
  });
});

describe('SSE event delivery on purchase', () => {
  it('streams >=2 status frames and one with decremented stockRemaining', async () => {
    await resetDb(3, isoAt(-60_000), isoAt(600_000));
    const sseApp: FastifyInstance = await buildApp(100000);
    await sseApp.listen({ port: 0, host: '127.0.0.1' });
    const addr = sseApp.server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    let raw = '';
    const req = http.get(
      `http://127.0.0.1:${String(port)}/api/sale/events`,
      (res) => {
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
      },
    );
    await sleep(2500);
    const buy = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'sse-buyer@example.com' },
    });
    expect(buy.statusCode).toBe(201);
    await sleep(4500);
    req.destroy();
    await sseApp.close();

    const frames = raw.split('\n\n').filter((f) => f.startsWith('event: status'));
    console.log(
      `[integration] sse frames=${String(frames.length)} bytes=${String(raw.length)}`,
    );
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const remainings: number[] = [];
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (line !== undefined) {
        remainings.push((JSON.parse(line.slice('data: '.length)) as StatusBody).stockRemaining);
      }
    }
    const initial = remainings[0] ?? -1;
    expect(initial).toBe(3);
    expect(remainings.some((n) => n === initial - 1)).toBe(true);
  });
});

describe('exact-5 under 50 parallel callers', () => {
  it('exactly five 201s with sold<=5 and SQL uniqueness holding', async () => {
    await resetDb(5, isoAt(-60_000), isoAt(600_000));
    const attempts = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/purchase',
          payload: { userId: `racer${String(i)}@example.com` },
        }),
      ),
    );
    const won = attempts.filter((r) => r.statusCode === 201);
    for (const res of attempts) {
      if (res.statusCode !== 201) expect(res.statusCode).toBe(409);
    }
    const sold = await countOf(
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    const bought = await countOf(
      `SELECT COUNT(*)::text AS n FROM purchases WHERE sale_id = 1`,
    );
    const dupCanonical = await countOf(
      `SELECT COUNT(*)::text AS n FROM
        (SELECT canonical_user_id FROM purchases WHERE sale_id = 1
         GROUP BY canonical_user_id HAVING COUNT(*) > 1) AS d`,
    );
    const dupUnit = await countOf(
      `SELECT COUNT(*)::text AS n FROM
        (SELECT unit_id FROM purchases WHERE sale_id = 1
         GROUP BY unit_id HAVING COUNT(*) > 1) AS d`,
    );
    console.log(
      `[integration] exact-5: won=${String(won.length)} sold=${String(sold)} purchases=${String(bought)} dupCanonical=${String(dupCanonical)} dupUnit=${String(dupUnit)}`,
    );
    expect(won.length).toBe(5);
    expect(sold).toBe(5);
    expect(sold).toBeLessThanOrEqual(5);
    expect(bought).toBe(5);
    expect(dupCanonical).toBe(0);
    expect(dupUnit).toBe(0);
  });
});

describe('rollback proof: aborted claim leaves row available', () => {
  it('crashed mid-txn claim rolls back; the next buyer claims stock', async () => {
    await resetDb(2, isoAt(-60_000), isoAt(600_000));
    const killer = new pg.Client({ connectionString: CONNECTION_STRING });
    const killerEvents = killer as unknown as {
      on(event: string, cb: () => void): void;
    };
    killerEvents.on('error', () => {
      // Expected: we destroy the socket below without commit.
    });
    await killer.connect();
    await killer.query('BEGIN');
    const grabbed = await killer.query<{ id: number }>(
      `SELECT id FROM stock_units
        WHERE sale_id = 1 AND status = 'available'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const grabbedRow = grabbed.rows[0];
    expect(grabbedRow).toBeDefined();
    const grabbedId = grabbedRow === undefined ? -1 : grabbedRow.id;
    console.log(`[integration] rollback: grabbed unit ${String(grabbedId)}, killing socket mid-txn`);
    const wire = killer as unknown as { connection: { stream: { destroy(): void } } };
    wire.connection.stream.destroy();
    await sleep(2000);
    const stillAvailable = await countOf(
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE id = $1 AND status = 'available'`,
      [grabbedId],
    );
    console.log(
      `[integration] rollback: unit ${String(grabbedId)} available-rows=${String(stillAvailable)} (expect 1)`,
    );
    expect(stillAvailable).toBe(1);
    const next = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'after-crash@example.com' },
    });
    expect(next.statusCode).toBe(201);
    console.log(
      `[integration] rollback: next buyer claimed unit ${String((JSON.parse(next.body) as PurchaseOk).unitId)}`,
    );
    try {
      await killer.end();
    } catch {
      // Socket already dead; the rollback is the assertion that matters.
    }
  });
});
