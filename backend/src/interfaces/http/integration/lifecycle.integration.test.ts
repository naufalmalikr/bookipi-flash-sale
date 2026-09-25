import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as PgClient } from 'pg';
import type { Application } from '../../../Application.ts';
import { buildHttpServer } from '../index.ts';
import {
  buildTestApplication,
  resetDb,
  isoAt,
  type StatusBody,
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

describe('lifecycle upcoming -> active -> ended', () => {
  it('gates purchases by the server window', async () => {
    await resetDb(client, application.cache, 5, isoAt(60_000), isoAt(600_000));
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

    await resetDb(client, application.cache, 5, isoAt(-60_000), isoAt(600_000));
    const onTime = await app.inject({
      method: 'POST',
      url: '/api/purchase',
      payload: { userId: 'ontime@example.com' },
    });
    expect(onTime.statusCode).toBe(201);
    expect((JSON.parse(onTime.body) as PurchaseOk).result).toBe('purchased');

    await resetDb(client, application.cache, 5, isoAt(-600_000), isoAt(-60_000));
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
