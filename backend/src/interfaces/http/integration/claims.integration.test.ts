import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as PgClient } from 'pg';
import type { Application } from '../../../Application.ts';
import { buildHttpServer } from '../index.ts';
import {
  buildTestApplication,
  resetDb,
  countOf,
  isoAt,
  type PurchaseOk,
  type ErrBody,
} from './helpers.ts';

let app: FastifyInstance;
let application: Application;
let client: PgClient;

beforeAll(async () => {
  const built = buildTestApplication();
  application = built.application;
  client = built.client;
  await client.connect();
  app = await buildHttpServer(application);
});

afterAll(async () => {
  try {
    await app.close();
  } catch {
    // Shared app may already be closed; pool shutdown below is what matters.
  }
  await application.database.close();
  await client.end();
});

describe('one-per-user incl. Gmail variant', () => {
  it('rejects the dotted twin with 409 and confirms one unit via lookup', async () => {
    await resetDb(client, application.cache, 5, isoAt(-60_000), isoAt(600_000));
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
    await resetDb(client, application.cache, 1, isoAt(-60_000), isoAt(600_000));
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
      client,
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    expect(sold).toBe(1);
  });
});

describe('same-user concurrent duplicate at exact exhaustion', () => {
  it('one 201 + one 409; at exhaustion the duplicate may read sold-out (accepted trade-off)', async () => {
    await resetDb(client, application.cache, 1, isoAt(-60_000), isoAt(600_000));
    const attempts = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'twin@example.com' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'twin@example.com' },
      }),
    ]);
    const won = attempts.filter((r) => r.statusCode === 201);
    const rejected = attempts.filter((r) => r.statusCode === 409);
    const sold = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    const labels = rejected.map((r) => (JSON.parse(r.body) as ErrBody).error);
    console.log(
      `[integration] m1: won=${String(won.length)} rejected=${String(rejected.length)} labels=${JSON.stringify(labels)} sold=${String(sold)} (expect 1/1/1 sold)`,
    );
    expect(won.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(labels.every((l) => l === 'already-purchased' || l === 'sold-out')).toBe(true);
    expect(sold).toBe(1);
  });

  it('duplicate that arrives after the winner commits still reads already-purchased (fast path)', async () => {
    await resetDb(client, application.cache, 1, isoAt(-60_000), isoAt(600_000));
    const first = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'late-twin@example.com' },
    });
    expect(first.statusCode).toBe(201);
    const repeat = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'late-twin@example.com' },
    });
    expect(repeat.statusCode).toBe(409);
    expect((JSON.parse(repeat.body) as ErrBody).error).toBe('already-purchased');
  });
});

describe('same-user concurrent duplicate with stock remaining', () => {
  it('one 201 + one 409 already-purchased via the UNIQUE constraint (23505 path)', async () => {
    await resetDb(client, application.cache, 5, isoAt(-60_000), isoAt(600_000));
    const attempts = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'racy@example.com' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'racy@example.com' },
      }),
    ]);
    const won = attempts.filter((r) => r.statusCode === 201);
    const dupes = attempts.filter(
      (r) => r.statusCode === 409 && (JSON.parse(r.body) as ErrBody).error === 'already-purchased',
    );
    const sold = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    const bought = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM purchases WHERE sale_id = 1`,
    );
    console.log(
      `[integration] 23505-race: won=${String(won.length)} dupes=${String(dupes.length)} sold=${String(sold)} purchases=${String(bought)} (expect 1/1/1/1)`,
    );
    expect(won.length).toBe(1);
    expect(dupes.length).toBe(1);
    expect(sold).toBe(1);
    expect(bought).toBe(1);
  });
});

describe('exact-5 under 50 parallel callers', () => {
  it('exactly five 201s with sold exactly 5 and SQL uniqueness holding', async () => {
    await resetDb(client, application.cache, 5, isoAt(-60_000), isoAt(600_000));
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
      client,
      `SELECT COUNT(*)::text AS n FROM stock_units WHERE sale_id = 1 AND status = 'sold'`,
    );
    const bought = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM purchases WHERE sale_id = 1`,
    );
    const dupCanonical = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM
        (SELECT canonical_user_id FROM purchases WHERE sale_id = 1
         GROUP BY canonical_user_id HAVING COUNT(*) > 1) AS d`,
    );
    const dupUnit = await countOf(
      client,
      `SELECT COUNT(*)::text AS n FROM
        (SELECT unit_id FROM purchases WHERE sale_id = 1
         GROUP BY unit_id HAVING COUNT(*) > 1) AS d`,
    );
    console.log(
      `[integration] exact-5: won=${String(won.length)} sold=${String(sold)} purchases=${String(bought)} dupCanonical=${String(dupCanonical)} dupUnit=${String(dupUnit)}`,
    );
    expect(won.length).toBe(5);
    expect(sold).toBe(5);
    expect(bought).toBe(5);
    expect(dupCanonical).toBe(0);
    expect(dupUnit).toBe(0);
  });
});
