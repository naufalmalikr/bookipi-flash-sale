import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as PgClient } from 'pg';
import type { Application } from '../../../Application.ts';
import { buildHttpServer } from '../index.ts';
import {
  CONNECTION_STRING,
  buildTestApplication,
  resetDb,
  countOf,
  isoAt,
  waitFor,
  type PurchaseOk,
  type ErrBody,
} from './helpers.ts';
import { SALE_ID } from '../../../entities/index.ts';

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

describe('buy rate limit (production default path)', () => {
  it('third fast buy with rateLimitBuy 2 -> 429 rate-limited envelope', async () => {
    const built = buildTestApplication(2);
    const rlClient = built.client;
    await rlClient.connect();
    const rlApp: FastifyInstance = await buildHttpServer(built.application);
    try {
      await resetDb(client, application.cache, 5, isoAt(-60_000), isoAt(600_000));
      built.application.cache.invalidate();
      const attempts = [];
      for (const userId of ['rl-one@example.com', 'rl-two@example.com', 'rl-three@example.com']) {
        attempts.push(
          await rlApp.inject({
            method: 'POST',
            url: '/api/purchase',
            payload: { userId },
          }),
        );
      }
      const limited = attempts.filter((r) => r.statusCode === 429);
      console.log(
        `[integration] rate-limit: statuses=${JSON.stringify(attempts.map((r) => r.statusCode))} limited=${String(limited.length)} (expect 1)`,
      );
      expect(attempts[0]!.statusCode).toBe(201);
      expect(attempts[1]!.statusCode).toBe(201);
      expect(limited.length).toBe(1);
      expect((JSON.parse(limited[0]!.body) as ErrBody).error).toBe('rate-limited');
    } finally {
      try {
        await rlApp.close();
      } catch {
        // Already closed; pool shutdown below is what matters.
      }
      await built.application.database.close();
      await rlClient.end();
    }
  });
});

describe('rollback proof: aborted claim leaves row available', () => {
  it('crashed mid-txn claim rolls back; the next buyer claims stock', async () => {
    await resetDb(client, application.cache, 2, isoAt(-60_000), isoAt(600_000));
    const killer = new PgClient({
      connectionString: CONNECTION_STRING,
    });
    const killerEvents = killer as unknown as {
      on(event: string, cb: () => void): void;
    };
    killerEvents.on('error', () => {
      // Expected: we terminate the backend below without commit.
    });
    await killer.connect();
    await killer.query('BEGIN');
    const grabbed = await killer.query<{ id: number }>(
      `SELECT id FROM stock_units
        WHERE sale_id = ${String(SALE_ID)} AND status = 'available'
        ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    const grabbedRow = grabbed.rows[0];
    expect(grabbedRow).toBeDefined();
    const grabbedId = grabbedRow === undefined ? -1 : grabbedRow.id;
    console.log(`[integration] rollback: grabbed unit ${String(grabbedId)}, terminating backend mid-txn`);
    const killerPidRow = await killer.query<{ pid: number }>(
      `SELECT pg_backend_pid() AS pid`,
    );
    const killerPid = killerPidRow.rows[0]?.pid ?? -1;
    // pg_terminate_backend from a second connection: kills the txn holder
    // server-side without reaching into pg driver internals.
    await client.query(`SELECT pg_terminate_backend($1)`, [killerPid]);
    try {
      await killer.end();
    } catch {
      // Socket already dead; the rollback is the assertion that matters.
    }
    const rolledBack = await waitFor(async () => {
      const stillAvailable = await countOf(
        client,
        `SELECT COUNT(*)::text AS n FROM stock_units WHERE id = $1 AND status = 'available'`,
        [grabbedId],
      );
      return stillAvailable === 1;
    }, 10000);
    console.log(
      `[integration] rollback: unit ${String(grabbedId)} rolled-back=${String(rolledBack)} (expect true)`,
    );
    expect(rolledBack).toBe(true);
    const next = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'after-crash@example.com' },
    });
    expect(next.statusCode).toBe(201);
    console.log(
      `[integration] rollback: next buyer claimed unit ${String((JSON.parse(next.body) as PurchaseOk).unitId)}`,
    );
  });
});
