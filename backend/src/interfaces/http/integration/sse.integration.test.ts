import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as PgClient } from 'pg';
import type { Application } from '../../../Application.ts';
import { buildHttpServer } from '../index.ts';
import {
  buildTestApplication,
  resetDb,
  isoAt,
  waitFor,
  type StatusBody,
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

describe('SSE event delivery on purchase', () => {
  it('streams >=2 status frames and one with decremented stockRemaining', async () => {
    await resetDb(client, application.cache, 3, isoAt(-60_000), isoAt(600_000));
    const built = buildTestApplication();
    const sseClient = built.client;
    await sseClient.connect();
    const sseApp: FastifyInstance = await buildHttpServer(built.application);
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
    try {
      const hasInitial = await waitFor(
        () => raw.split('\n\n').filter((f) => f.startsWith('event: status')).length >= 1,
        10000,
      );
      expect(hasInitial).toBe(true);
      const buy = await sseApp.inject({
        method: 'POST',
        url: '/api/purchase',
        payload: { userId: 'sse-buyer@example.com' },
      });
      expect(buy.statusCode).toBe(201);
      const hasDecrement = await waitFor(
        () => {
          const frames = raw.split('\n\n').filter((f) => f.startsWith('event: status'));
          if (frames.length < 2) return false;
          const remainings: number[] = [];
          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line !== undefined) {
              try {
                remainings.push((JSON.parse(line.slice('data: '.length)) as StatusBody).stockRemaining);
              } catch {
                // Partial frame mid-write; next poll sees the full frame.
              }
            }
          }
          const initial = remainings[0] ?? -1;
          return initial === 3 && remainings.some((n) => n === initial - 1);
        },
        15000,
      );
      const frames = raw.split('\n\n').filter((f) => f.startsWith('event: status'));
      console.log(
        `[integration] sse frames=${String(frames.length)} bytes=${String(raw.length)}`,
      );
      expect(frames.length).toBeGreaterThanOrEqual(2);
      expect(hasDecrement).toBe(true);
    } finally {
      req.destroy();
      await sseApp.close();
      await built.application.database.close();
      await sseClient.end();
    }
  });
});
